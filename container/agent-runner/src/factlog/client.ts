/**
 * Thin HTTP client for the factlog daemon, over the bind-mounted unix socket
 * (Bun fetch's `unix` option) or the host gateway URL. Used by the runner's
 * lifecycle hooks; the agent's own writes go through the daemon's MCP surface
 * via the loopback proxy (proxy.ts), never through this module.
 *
 * Failure posture: fail-open with a log line. If the daemon is unreachable
 * the agent runs without briefs and without gates — availability of message
 * delivery outranks coordination. (The daemon still holds the trust
 * boundary: no reachability, no writes.)
 */
import type { FactlogRunConfig } from './config.js';

function log(msg: string): void {
  console.error(`[factlog] ${msg}`);
}

/** Placeholder authority for socket-transport URLs; Bun routes via `unix`. */
const SOCKET_BASE = 'http://factlog';

export function factlogFetch(cfg: FactlogRunConfig, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const base = cfg.transport === 'socket' ? SOCKET_BASE : cfg.url!;
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${cfg.token}`);
  const opts: RequestInit & { unix?: string } = { ...init, headers };
  if (cfg.transport === 'socket') opts.unix = cfg.socket;
  return fetch(`${base}${pathAndQuery}`, opts);
}

/**
 * GET /brief — the run's wake-up context: invariants, decisions, open
 * questions, last handoff for the agent's home scopes, rendered for prompt
 * injection. Null when the daemon is unreachable or errors.
 */
export async function fetchBrief(cfg: FactlogRunConfig, budgetTokens = 500): Promise<string | null> {
  const params = new URLSearchParams({ budget: String(budgetTokens), format: 'prompt' });
  for (const scope of cfg.homeScopes ?? []) params.append('scope', scope);
  try {
    const res = await factlogFetch(cfg, `/brief?${params}`);
    if (!res.ok) {
      log(`brief fetch failed: HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log(`brief fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * GET {catalogUrl}/brief?block=… — the block-scoped brief from the
 * factlog-catalog serve endpoint (a separate read-model; the daemon's /brief
 * only knows scopes). Reached over the host gateway even on socket transport,
 * so it always goes through the network client, never the daemon socket. Null
 * when catalog/blocks are absent, unreachable, or the endpoint errors — the
 * scope brief still stands on its own.
 */
export async function fetchBlockBrief(cfg: FactlogRunConfig, budgetTokens = 500): Promise<string | null> {
  if (cfg.catalogUrl === undefined || (cfg.homeBlocks ?? []).length === 0) return null;
  const params = new URLSearchParams({ budget: String(budgetTokens), format: 'prompt' });
  for (const block of cfg.homeBlocks ?? []) params.append('block', block);
  try {
    // Same bearer token as the daemon; the catalog ignores it (read-only,
    // reachability is the grant). Sending it keeps one auth path.
    const res = await fetch(`${cfg.catalogUrl}/brief?${params}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) {
      log(`block brief fetch failed: HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log(`block brief fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface HookDecision {
  decision?: 'block';
  reason?: string;
}

/**
 * POST /hooks/pre-tool-use | /hooks/stop — the daemon's zero-spawn hook
 * endpoints. `?session=` pins the event to this run's factlog session (the
 * daemon prefers it over any id in the event body). Null on transport error.
 */
export async function postHookEvent(
  cfg: FactlogRunConfig,
  kind: 'pre-tool-use' | 'stop',
  event: Record<string, unknown>,
): Promise<HookDecision | null> {
  try {
    const res = await factlogFetch(cfg, `/hooks/${kind}?session=${encodeURIComponent(cfg.session)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      log(`hook ${kind} failed: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as HookDecision;
  } catch (err) {
    log(`hook ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
