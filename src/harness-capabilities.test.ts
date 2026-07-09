import { describe, expect, it } from 'vitest';

import {
  HARNESS_CAPABILITY_DEFAULTS,
  parseHarnessCapabilitiesArg,
  resolveHarnessCapabilities,
} from './harness-capabilities.js';

describe('resolveHarnessCapabilities', () => {
  it('returns code defaults for empty/missing overrides', () => {
    for (const input of [undefined, null, '', '{}']) {
      expect(resolveHarnessCapabilities(input)).toEqual(HARNESS_CAPABILITY_DEFAULTS);
    }
    expect(HARNESS_CAPABILITY_DEFAULTS).toEqual({ 'agent-teams': 'off', workflow: 'off' });
  });

  it('applies stored overrides on top of defaults', () => {
    expect(resolveHarnessCapabilities('{"workflow":"on"}')).toEqual({ 'agent-teams': 'off', workflow: 'on' });
    expect(resolveHarnessCapabilities('{"agent-teams":"on","workflow":"on"}')).toEqual({
      'agent-teams': 'on',
      workflow: 'on',
    });
  });

  it('degrades malformed JSON to defaults instead of throwing', () => {
    expect(resolveHarnessCapabilities('{nope')).toEqual(HARNESS_CAPABILITY_DEFAULTS);
    expect(resolveHarnessCapabilities('[1,2]')).toEqual(HARNESS_CAPABILITY_DEFAULTS);
    expect(resolveHarnessCapabilities('"off"')).toEqual(HARNESS_CAPABILITY_DEFAULTS);
  });

  it('drops unknown keys and garbage values back to defaults (never leaks into the resolved map)', () => {
    const resolved = resolveHarnessCapabilities('{"monitor":"off","workflow":"sideways","future":{"nested":1}}');
    expect(Object.hasOwn(resolved, 'monitor')).toBe(false); // unknown key dropped
    expect(Object.hasOwn(resolved, 'future')).toBe(false); // unknown non-string dropped
    expect(resolved.workflow).toBe('off'); // garbage value → default, not 'sideways'
    expect(resolved['agent-teams']).toBe('off');
  });

  it('accepts an already-parsed override map', () => {
    expect(resolveHarnessCapabilities({ workflow: 'on' })).toEqual({ 'agent-teams': 'off', workflow: 'on' });
  });

  it('does not treat inherited Object.prototype names as known keys', () => {
    // `key in obj` would be true for 'constructor'/'toString'; Object.hasOwn is not.
    const resolved = resolveHarnessCapabilities('{"constructor":"on","toString":"off"}');
    expect(resolved).toEqual({ 'agent-teams': 'off', workflow: 'off' });
  });
});

describe('parseHarnessCapabilitiesArg', () => {
  it('parses on/off/default directives into a key→directive map', () => {
    expect(parseHarnessCapabilitiesArg('agent-teams=on')).toEqual({ 'agent-teams': 'on' });
    expect(parseHarnessCapabilitiesArg('workflow=default')).toEqual({ workflow: 'default' });
    expect(parseHarnessCapabilitiesArg('agent-teams=on, workflow=default')).toEqual({
      'agent-teams': 'on',
      workflow: 'default',
    });
  });

  it('resolves a repeated key last-wins', () => {
    expect(parseHarnessCapabilitiesArg('workflow=on,workflow=default')).toEqual({ workflow: 'default' });
    expect(parseHarnessCapabilitiesArg('workflow=default,workflow=on')).toEqual({ workflow: 'on' });
  });

  it('normalizes key case and underscores', () => {
    expect(parseHarnessCapabilitiesArg('AGENT_TEAMS=ON')).toEqual({ 'agent-teams': 'on' });
  });

  it('rejects unknown keys, including inherited prototype names', () => {
    expect(() => parseHarnessCapabilitiesArg('web=off')).toThrow(/unknown harness capability "web".*agent-teams/);
    expect(() => parseHarnessCapabilitiesArg('constructor=on')).toThrow(/unknown harness capability "constructor"/);
  });

  it('rejects bad values and malformed pairs', () => {
    expect(() => parseHarnessCapabilitiesArg('workflow=maybe')).toThrow(/must be on, off, or default/);
    expect(() => parseHarnessCapabilitiesArg('workflow')).toThrow(/must be key=value/);
    expect(() => parseHarnessCapabilitiesArg('  ,  ')).toThrow(/requires one or more/);
  });
});
