import { describe, expect, it } from 'vitest';

import { redactDetails } from './redact.js';

describe('redactDetails', () => {
  it('masks sensitive keys at any depth, case-insensitively', () => {
    const out = redactDetails({
      name: 'notion',
      env: { NOTION_TOKEN: 'secret-value', SAFE_VALUE: 'ok' },
      nested: { Authorization: 'Bearer abc', list: [{ 'api-key': 'k' }, { plain: 'p' }] },
      password: 'hunter2',
    });
    expect(out).toEqual({
      name: 'notion',
      env: { NOTION_TOKEN: '[REDACTED]', SAFE_VALUE: 'ok' },
      nested: { Authorization: '[REDACTED]', list: [{ 'api-key': '[REDACTED]' }, { plain: 'p' }] },
      password: '[REDACTED]',
    });
  });

  it('matches the documented key pattern (token|secret|key|password|credential|auth|bearer)', () => {
    const out = redactDetails({
      access_token: 'x',
      clientSecret: 'x',
      ssh_key: 'x',
      credentials: 'x',
      oauth_flow: 'x',
      bearerValue: 'x',
      username: 'moshe',
    });
    expect(Object.entries(out).filter(([, v]) => v === '[REDACTED]')).toHaveLength(6);
    expect(out.username).toBe('moshe');
  });

  it('never recurses into a masked key — the whole value is replaced', () => {
    const out = redactDetails({ auth: { inner: 'visible?' } });
    expect(out.auth).toBe('[REDACTED]');
  });

  it('truncates strings over 2 KB post-redaction', () => {
    const long = 'a'.repeat(5000);
    const out = redactDetails({ blob: long, short: 'b' });
    expect(out.blob).toBe('a'.repeat(2048) + '…[truncated]');
    expect(out.short).toBe('b');
  });

  it('passes non-string scalars through untouched', () => {
    const out = redactDetails({ n: 42, b: true, z: null, u: undefined });
    expect(out).toEqual({ n: 42, b: true, z: null, u: undefined });
  });

  it('caps depth (cycle guard) without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactDetails(cyclic);
    let cursor: unknown = out;
    for (let i = 0; i < 20 && typeof cursor === 'object' && cursor !== null; i++) {
      cursor = (cursor as Record<string, unknown>).self;
    }
    expect(cursor).toBe('[MAX_DEPTH]');
  });

  it('does not mutate the input', () => {
    const input = { token: 'x', nested: { list: ['a'.repeat(3000)] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactDetails(input);
    expect(input).toEqual(snapshot);
  });
});
