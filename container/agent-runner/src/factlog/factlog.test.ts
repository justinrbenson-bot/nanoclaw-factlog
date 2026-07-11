/**
 * factlog container-side tests: run config parsing, the UDS/TCP client, the
 * loopback MCP proxy, and the lifecycle hooks — all against a mock daemon
 * served by Bun on a real unix socket (the production transport shape).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fetchBlockBrief, fetchBrief, postHookEvent } from './client.js';
import { loadFactlogRunConfig, type FactlogRunConfig } from './config.js';
import { createFactlogHooks, destinationScope } from './hooks.js';
import { startFactlogProxy } from './proxy.js';
import type { DestinationEntry } from '../destinations.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
const socketPath = path.join(tmpDir, 'd.sock');

// ── mock daemon ──
interface Seen {
  path: string;
  method: string;
  auth: string | null;
  body: unknown;
}
const seen: Seen[] = [];
let briefText = 'INVARIANTS:\n- [inv] quiet hours 22:00-08:00';
let hookResponse: Record<string, unknown> = {};

const daemon = Bun.serve({
  unix: socketPath,
  fetch: async (req) => {
    const url = new URL(req.url);
    seen.push({
      path: url.pathname + url.search,
      method: req.method,
      auth: req.headers.get('authorization'),
      body: req.method === 'POST' ? await req.json() : null,
    });
    if (url.pathname === '/brief') return new Response(briefText);
    if (url.pathname.startsWith('/hooks/')) return Response.json(hookResponse);
    if (url.pathname === '/echo') return Response.json({ ok: true });
    return new Response('not found', { status: 404 });
  },
});

// ── mock catalog (TCP; the catalog is HTTP-only, reached over host-gateway) ──
const catalogSeen: Seen[] = [];
let catalogBriefText = '[seq 3] decision planner@claude: use a token bucket';
const catalog = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    catalogSeen.push({
      path: url.pathname + url.search,
      method: req.method,
      auth: req.headers.get('authorization'),
      body: null,
    });
    if (url.pathname === '/brief') return new Response(catalogBriefText);
    return new Response('not found', { status: 404 });
  },
});
const catalogUrl = `http://127.0.0.1:${catalog.port}`;

afterAll(() => {
  daemon.stop(true);
  catalog.stop(true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const cfg: FactlogRunConfig = {
  transport: 'socket',
  socket: socketPath,
  token: 'flt_testtoken',
  agent: 'meal-planner',
  session: 'nc-run-1',
  homeScopes: ['topic://meals/**', 'job://**'],
};

/** cfg pointing at a dead endpoint — exercises the fail-open paths. */
const deadCfg: FactlogRunConfig = { ...cfg, transport: 'http', url: 'http://127.0.0.1:9', socket: undefined };

const signal = new AbortController().signal;

/** cfg with block homes pointed at the mock catalog. */
const blockCfg: FactlogRunConfig = { ...cfg, homeBlocks: ['topic:ratelimiter', 'job:impl'], catalogUrl };

beforeEach(() => {
  seen.length = 0;
  catalogSeen.length = 0;
  hookResponse = {};
});

describe('loadFactlogRunConfig', () => {
  it('parses a valid identity file', () => {
    const file = path.join(tmpDir, 'factlog.json');
    fs.writeFileSync(file, JSON.stringify(cfg));
    expect(loadFactlogRunConfig(file)).toEqual(cfg);
  });

  it('returns null when the file is absent (factlog disabled)', () => {
    expect(loadFactlogRunConfig(path.join(tmpDir, 'nope.json'))).toBeNull();
  });

  it('returns null on malformed or incomplete identity', () => {
    const file = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(file, 'not json');
    expect(loadFactlogRunConfig(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ transport: 'socket', token: 'flt_x' })); // no session/socket
    expect(loadFactlogRunConfig(file)).toBeNull();
  });
});

describe('client over the unix socket', () => {
  it('fetches the brief with home scopes and the bearer token', async () => {
    const brief = await fetchBrief(cfg);
    expect(brief).toBe(briefText);
    expect(seen[0].auth).toBe('Bearer flt_testtoken');
    expect(seen[0].path).toContain('budget=500');
    expect(seen[0].path).toContain('format=prompt');
    expect(seen[0].path).toContain(`scope=${encodeURIComponent('topic://meals/**')}`);
    expect(seen[0].path).toContain(`scope=${encodeURIComponent('job://**')}`);
  });

  it('posts hook events pinned to the run session', async () => {
    hookResponse = { decision: 'block', reason: 'INVARIANT: quiet hours' };
    const result = await postHookEvent(cfg, 'pre-tool-use', { tool_name: 'x' });
    expect(result).toEqual({ decision: 'block', reason: 'INVARIANT: quiet hours' });
    expect(seen[0].path).toBe(`/hooks/pre-tool-use?session=${encodeURIComponent('nc-run-1')}`);
  });

  it('fails open (null) when the daemon is unreachable', async () => {
    expect(await fetchBrief(deadCfg)).toBeNull();
    expect(await postHookEvent(deadCfg, 'stop', {})).toBeNull();
  });
});

describe('fetchBlockBrief (catalog over TCP)', () => {
  it('fetches the block brief with each block as a query param', async () => {
    const brief = await fetchBlockBrief(blockCfg);
    expect(brief).toBe(catalogBriefText);
    expect(catalogSeen[0].auth).toBe('Bearer flt_testtoken');
    expect(catalogSeen[0].path).toContain('budget=500');
    expect(catalogSeen[0].path).toContain('format=prompt');
    expect(catalogSeen[0].path).toContain('block=topic%3Aratelimiter');
    expect(catalogSeen[0].path).toContain('block=job%3Aimpl');
  });

  it('returns null (no fetch) when no catalog URL or no blocks are set', async () => {
    expect(await fetchBlockBrief(cfg)).toBeNull(); // no catalogUrl
    expect(await fetchBlockBrief({ ...blockCfg, homeBlocks: [] })).toBeNull();
    expect(catalogSeen.length).toBe(0);
  });

  it('fails open (null) when the catalog is unreachable', async () => {
    const dead = { ...blockCfg, catalogUrl: 'http://127.0.0.1:9' };
    expect(await fetchBlockBrief(dead)).toBeNull();
  });
});

describe('proxy', () => {
  it('forwards requests over the socket and injects the token', async () => {
    const proxy = startFactlogProxy(cfg);
    try {
      const res = await fetch(`${proxy.url}/echo?a=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'daemon' }),
      });
      expect(await res.json()).toEqual({ ok: true });
      expect(seen[0].path).toBe('/echo?a=1');
      expect(seen[0].auth).toBe('Bearer flt_testtoken');
      expect(seen[0].body).toEqual({ hello: 'daemon' });
    } finally {
      proxy.stop();
    }
  });
});

describe('destinationScope', () => {
  const family: DestinationEntry = { name: 'family', displayName: 'Family', type: 'channel', channelType: 'whatsapp' };
  const scheduler: DestinationEntry = { name: 'scheduler', displayName: 'Scheduler', type: 'agent' };

  it('maps channel destinations to channel://<channelType>/<name>', () => {
    expect(destinationScope('family', family)).toBe('channel://whatsapp/family');
  });

  it('maps agent destinations under channel://agent/', () => {
    expect(destinationScope('scheduler', scheduler)).toBe('channel://agent/scheduler');
  });

  it('still yields a scope for unknown destinations', () => {
    expect(destinationScope('mystery', undefined)).toBe('channel://mystery');
  });
});

describe('lifecycle hooks', () => {
  const family: DestinationEntry = { name: 'family', displayName: 'Family', type: 'channel', channelType: 'whatsapp' };
  const deps = {
    resolveDestination: (name: string) => (name === 'family' ? family : undefined),
    resolveDefaultDestination: () => family,
  };
  const hooks = createFactlogHooks(cfg, deps);

  it('SessionStart injects the brief as additional context', async () => {
    const out = (await hooks.SessionStart![0]({ source: 'startup' }, undefined, { signal })) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput?.additionalContext).toContain('quiet hours');
    expect(out.hookSpecificOutput?.additionalContext).toContain('factlog');
  });

  it('SessionStart returns {} when the daemon is unreachable', async () => {
    const out = await createFactlogHooks(deadCfg, deps).SessionStart![0]({}, undefined, { signal });
    expect(out).toEqual({});
  });

  it('SessionStart appends the block brief under an assigned-blocks heading', async () => {
    const out = (await createFactlogHooks(blockCfg, deps).SessionStart![0]({ source: 'startup' }, undefined, {
      signal,
    })) as { hookSpecificOutput?: { additionalContext: string } };
    const ctx = out.hookSpecificOutput!.additionalContext;
    expect(ctx).toContain('quiet hours'); // scope brief (daemon)
    expect(ctx).toContain('### assigned blocks');
    expect(ctx).toContain('token bucket'); // block brief (catalog)
  });

  it('SessionStart still injects the block brief when the scope brief is empty', async () => {
    // blockCfg with no home scopes: daemon still returns briefText here, so
    // point it at the dead daemon URL but keep the live catalog.
    const onlyBlocks = { ...blockCfg, transport: 'http' as const, url: 'http://127.0.0.1:9', socket: undefined };
    const out = (await createFactlogHooks(onlyBlocks, deps).SessionStart![0]({}, undefined, { signal })) as {
      hookSpecificOutput?: { additionalContext: string };
    };
    expect(out.hookSpecificOutput?.additionalContext).toContain('token bucket');
  });

  it('PreToolUse ignores non-effectful tools without calling the daemon', async () => {
    const out = await hooks.PreToolUse![0]({ tool_name: 'Read', tool_input: { file_path: '/x' } }, undefined, {
      signal,
    });
    expect(out).toEqual({ continue: true });
    expect(seen.length).toBe(0);
  });

  it('PreToolUse maps an explicit send destination to a channel scope and relays a block', async () => {
    hookResponse = { decision: 'block', reason: 'INVARIANT: quiet hours [f-1]' };
    const out = await hooks.PreToolUse![0](
      { tool_name: 'mcp__nanoclaw__send_message', tool_input: { to: 'family', text: 'hi' } },
      undefined,
      { signal },
    );
    expect(out).toEqual({ decision: 'block', stopReason: 'INVARIANT: quiet hours [f-1]' });
    const event = seen[0].body as { factlog_scope: string[]; factlog_session: string };
    expect(event.factlog_scope).toEqual(['channel://whatsapp/family']);
    expect(event.factlog_session).toBe('nc-run-1');
  });

  it('PreToolUse gates reply-in-place sends via the default destination', async () => {
    await hooks.PreToolUse![0]({ tool_name: 'mcp__nanoclaw__send_message', tool_input: { text: 'hi' } }, undefined, {
      signal,
    });
    const event = seen[0].body as { factlog_scope: string[] };
    expect(event.factlog_scope).toEqual(['channel://whatsapp/family']);
  });

  it('PreToolUse allows the send when the daemon allows', async () => {
    hookResponse = {};
    const out = await hooks.PreToolUse![0](
      { tool_name: 'mcp__nanoclaw__send_message', tool_input: { to: 'family', text: 'hi' } },
      undefined,
      { signal },
    );
    expect(out).toEqual({ continue: true });
  });

  it('PreToolUse fails open when the daemon is unreachable', async () => {
    const out = await createFactlogHooks(deadCfg, deps).PreToolUse![0](
      { tool_name: 'mcp__nanoclaw__send_message', tool_input: { to: 'family', text: 'hi' } },
      undefined,
      { signal },
    );
    expect(out).toEqual({ continue: true });
  });

  it('Stop relays the daemon stop gate and passes the loop guard through', async () => {
    hookResponse = { decision: 'block', reason: 'Before stopping: post a handoff fact' };
    const out = await hooks.Stop![0]({ stop_hook_active: false }, undefined, { signal });
    expect(out).toEqual({ decision: 'block', stopReason: 'Before stopping: post a handoff fact' });
    expect((seen[0].body as { stop_hook_active: boolean }).stop_hook_active).toBe(false);

    hookResponse = {};
    const out2 = await hooks.Stop![0]({ stop_hook_active: true }, undefined, { signal });
    expect(out2).toEqual({});
    expect((seen[1].body as { stop_hook_active: boolean }).stop_hook_active).toBe(true);
  });
});
