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

  it('passes unknown keys through and keeps defaults for garbage values on known keys', () => {
    const resolved = resolveHarnessCapabilities('{"monitor":"off","workflow":"sideways"}');
    expect(resolved.monitor).toBe('off');
    expect(resolved.workflow).toBe('off'); // garbage value → default, not 'sideways'
    expect(resolved['agent-teams']).toBe('off');
  });
});

describe('parseHarnessCapabilitiesArg', () => {
  it('parses set and clear operations', () => {
    expect(parseHarnessCapabilitiesArg('agent-teams=on')).toEqual({ set: { 'agent-teams': 'on' }, clear: [] });
    expect(parseHarnessCapabilitiesArg('workflow=default')).toEqual({ set: {}, clear: ['workflow'] });
    expect(parseHarnessCapabilitiesArg('agent-teams=on, workflow=default')).toEqual({
      set: { 'agent-teams': 'on' },
      clear: ['workflow'],
    });
  });

  it('normalizes key case and underscores', () => {
    expect(parseHarnessCapabilitiesArg('AGENT_TEAMS=ON')).toEqual({ set: { 'agent-teams': 'on' }, clear: [] });
  });

  it('rejects unknown keys with the allowed set in the message', () => {
    expect(() => parseHarnessCapabilitiesArg('web=off')).toThrow(/unknown harness capability "web".*agent-teams/);
  });

  it('rejects bad values and malformed pairs', () => {
    expect(() => parseHarnessCapabilitiesArg('workflow=maybe')).toThrow(/must be on, off, or default/);
    expect(() => parseHarnessCapabilitiesArg('workflow')).toThrow(/must be key=value/);
    expect(() => parseHarnessCapabilitiesArg('  ,  ')).toThrow(/requires one or more/);
  });
});
