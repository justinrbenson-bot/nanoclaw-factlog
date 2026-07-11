/**
 * Readiness gate for the factlog HTTP MCP server.
 *
 * The Claude Agent SDK connects registered MCP servers asynchronously and
 * begins the first turn; a server whose connect + tools/list hasn't completed
 * in time is simply absent from that turn's tool list. The stdio `nanoclaw`
 * server is effectively instant, but the HTTP `factlog` server has an extra
 * network hop (loopback proxy → daemon /mcp) and, against a cold daemon/proxy,
 * intermittently loses the race — so `mcp__factlog__*` tools never appear,
 * independent of any API throttling that perturbs turn timing.
 *
 * This pre-warms and confirms the EXACT proxy URL the SDK will use, so by the
 * time the provider starts, the SDK's own connect resolves fast. We probe
 * through the proxy, which stamps the Bearer token itself — no token here.
 *
 * Fail-open: if the daemon never becomes ready within the budget we return
 * false and let the run proceed without factlog. Message delivery outranks
 * coordination; the caller logs the degradation.
 */
function log(msg: string): void {
  console.error(`[factlog] ${msg}`);
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'nanoclaw-readiness-probe', version: '1' },
  },
});

export interface ReadinessOptions {
  /** Total time to keep retrying before giving up (fail-open). */
  budgetMs?: number;
  /** Per-attempt timeout — a cold connect that hangs shouldn't eat the budget. */
  attemptTimeoutMs?: number;
}

/**
 * Poll the proxy's /mcp with a real MCP `initialize` until the daemon accepts
 * it (HTTP 2xx) or the budget expires. A 2xx means the full proxy → daemon
 * path is warm and the SDK's subsequent connect will be fast. Returns whether
 * it became ready.
 */
export async function waitForFactlogMcpReady(
  mcpUrl: string,
  { budgetMs = 15_000, attemptTimeoutMs = 2_000 }: ReadinessOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let delay = 200;
  let attempts = 0;
  for (;;) {
    attempts++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), attemptTimeoutMs);
    try {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: INIT_BODY,
      });
      if (res.ok) {
        // Don't consume the (SSE) body — we only needed the accept. Dropping
        // the stream ends this probe session; the SDK opens its own.
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        return true;
      }
    } catch {
      // connection refused / reset / abort — daemon or proxy not ready yet
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) {
      log(`MCP not ready after ${attempts} attempt(s) / ${budgetMs}ms — proceeding without factlog tools`);
      return false;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1_000);
  }
}
