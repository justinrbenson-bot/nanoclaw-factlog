import { describe, expect, it } from 'bun:test';

import { configFromRaw } from './config.js';

describe('configFromRaw harnessCapabilities', () => {
  it('treats a missing field as a pre-capability host — legacy all-on, not all-off', () => {
    // Update-window skew: the bind-mounted runner source is already
    // capability-aware while the still-running old host wrote container.json
    // without the field. Those groups ran with teams + Workflow on; defaulting
    // to {} here would regress them to all-off until the host restarts.
    expect(configFromRaw({}).harnessCapabilities).toEqual({ 'agent-teams': 'on', workflow: 'on' });
  });

  it('passes an explicit host-resolved map through untouched', () => {
    const caps = { 'agent-teams': 'off', workflow: 'off' };
    expect(configFromRaw({ harnessCapabilities: caps }).harnessCapabilities).toEqual(caps);
  });
});
