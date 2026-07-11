/**
 * Loopback proxy: 127.0.0.1:<ephemeral> → factlog daemon.
 *
 * The daemon's canonical agent write surface is MCP streamable-HTTP at /mcp,
 * but the SDK's MCP connections are made by the provider subprocess (Claude
 * Code), which can speak TCP only — it can't reach a unix socket. This proxy
 * bridges: it listens on container-private loopback, forwards every request
 * over the mounted socket (or host-gateway URL), and injects this run's
 * Bearer token so the daemon stamps the actor server-side. The subprocess
 * never sees the token.
 *
 * Loopback inside the container's network namespace is unreachable from
 * other containers and from the host — this opens no new channel.
 */
import type { FactlogRunConfig } from './config.js';

export interface FactlogProxy {
  /** Base URL, e.g. http://127.0.0.1:49321 — MCP endpoint is `${url}/mcp`. */
  url: string;
  stop(): void;
}

export function startFactlogProxy(cfg: FactlogRunConfig): FactlogProxy {
  const base = cfg.transport === 'socket' ? 'http://factlog' : cfg.url!;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // MCP streamable-HTTP holds a long-lived SSE stream; never idle it out.
    idleTimeout: 0,
    fetch: (req) => {
      const incoming = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set('authorization', `Bearer ${cfg.token}`);
      headers.delete('host');
      const init: RequestInit & { unix?: string } = {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual',
      };
      if (cfg.transport === 'socket') init.unix = cfg.socket;
      return fetch(`${base}${incoming.pathname}${incoming.search}`, init);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
  };
}
