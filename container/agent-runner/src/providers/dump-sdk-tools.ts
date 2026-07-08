/**
 * Regenerates sdk-tools-baseline.json — the bare SDK tool-surface fixture
 * asserted by claude.tools.test.ts.
 *
 * Must run INSIDE the agent container image (the pinned CLI binary only
 * exists there). From the repo root:
 *
 *   docker run --rm --network none \
 *     -v "$PWD/container/agent-runner/src":/app/src:ro \
 *     --entrypoint bun <nanoclaw-agent image> /app/src/providers/dump-sdk-tools.ts \
 *     > container/agent-runner/src/providers/sdk-tools-baseline.json
 *
 * Two captures, because `allowedTools` is measured to be FULLY INERT under
 * bypassPermissions (both captures are byte-identical on the current pins):
 *   - `tools`     : with the production TOOL_ALLOWLIST.
 *   - `toolsBare` : with no allowedTools.
 * The drift test asserts tools === toolsBare. If a CLI/SDK bump ever makes the
 * allowlist shape the surface (promote or filter), that assertion fails and
 * forces a deliberate re-read of the allowlist's semantics — that is the only
 * reason both captures exist. Neither capture passes disallowedTools;
 * agent-teams is enabled via a temp settings.json (settings env strictly beats
 * SDK options env — see docs/harness-capabilities.md).
 *
 * Zero API traffic: ANTHROPIC_BASE_URL points at an in-process stub answering
 * 401; the full tools array rides on the first /v1/messages request, captured
 * before the run dies on the auth error. The fixture records WIRE tool names
 * (the SDK init message reports legacy aliases, e.g. `Task` for wire `Agent` —
 * do not swap this to an init capture).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { TOOL_ALLOWLIST } from './claude.js';

let requests: string[] = [];
let captured: (() => void) | null = null;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    if (url.pathname.includes('/messages')) {
      requests.push(body);
      captured?.();
    }
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture-capture-stub' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  },
});

const HOME = '/tmp/dump-sdk-tools-home';
const CWD = '/tmp/dump-sdk-tools-ws';
fs.mkdirSync(`${HOME}/.claude`, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(
  `${HOME}/.claude/settings.json`,
  JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }, null, 2),
);

/** Run one capture and return the sorted wire tool names. */
async function capture(allowedTools?: string[]): Promise<string[]> {
  requests = [];
  const firstRequest = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const q = query({
    prompt: 'fixture capture: reply with one word',
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: '/pnpm/claude',
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
      env: {
        ...process.env,
        HOME,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_API_KEY: 'fixture-dummy-key',
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['user'],
      ...(allowedTools ? { allowedTools } : {}),
    },
  });
  void (async () => {
    try {
      for await (const _m of q) {
        /* drain until the auth error kills the run */
      }
    } catch {
      /* expected: 401 from the stub */
    }
  })();
  await Promise.race([firstRequest, Bun.sleep(75_000)]);
  await Bun.sleep(1_500); // let retries land so we can pick the largest body
  if (requests.length === 0) {
    console.error('[dump-sdk-tools] no /v1/messages request captured');
    process.exit(1);
  }
  const biggest = requests.reduce((a, b) => (b.length > a.length ? b : a));
  const parsed = JSON.parse(biggest) as { tools?: Array<{ name: string }> };
  return [...new Set((parsed.tools ?? []).map((t) => t.name))].sort();
}

const tools = await capture(TOOL_ALLOWLIST);
const toolsBare = await capture();

const cliVersionRaw = execFileSync('/pnpm/claude', ['--version'], { encoding: 'utf8' }).trim();
const cliVersion = cliVersionRaw.split(/\s+/)[0];
const sdkVersion = (
  JSON.parse(fs.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8')) as {
    version: string;
  }
).version;

console.log(
  JSON.stringify(
    {
      cliVersion,
      sdkVersion,
      capturedAt: new Date().toISOString(),
      capture:
        'wire names; tools=production allowlist surface, toolsBare=no allowedTools; no disallowedTools; teams on',
      tools,
      toolsBare,
    },
    null,
    2,
  ),
);
process.exit(0);
