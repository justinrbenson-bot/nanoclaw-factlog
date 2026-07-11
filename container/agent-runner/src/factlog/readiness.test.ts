import { describe, expect, test } from 'bun:test';

import { waitForFactlogMcpReady } from './readiness.js';

describe('waitForFactlogMcpReady', () => {
  test('returns true immediately when the endpoint accepts the initialize', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok', { status: 200 }) });
    try {
      const start = Date.now();
      const ready = await waitForFactlogMcpReady(`http://127.0.0.1:${server.port}/mcp`);
      expect(ready).toBe(true);
      expect(Date.now() - start).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test('fails open (false) within budget when nothing is listening', async () => {
    // Port 1 is privileged/unused — connect is refused.
    const start = Date.now();
    const ready = await waitForFactlogMcpReady('http://127.0.0.1:1/mcp', { budgetMs: 400, attemptTimeoutMs: 100 });
    expect(ready).toBe(false);
    // Bounded by the budget, not left hanging.
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  test('retries until the daemon becomes ready (cold start)', async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        hits++;
        // Not ready for the first two probes, then accepts.
        return hits < 3 ? new Response('warming', { status: 503 }) : new Response('ok', { status: 200 });
      },
    });
    try {
      const ready = await waitForFactlogMcpReady(`http://127.0.0.1:${server.port}/mcp`, { budgetMs: 5_000 });
      expect(ready).toBe(true);
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      server.stop(true);
    }
  });
});
