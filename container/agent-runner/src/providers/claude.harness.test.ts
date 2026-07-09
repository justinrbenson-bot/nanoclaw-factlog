/**
 * Harness-capability mapping in the Claude provider: the disallow list is the
 * fixed set plus capability-driven entries (fail closed), and the PreToolUse
 * hook blocks exactly that list. Pure — no SDK, no DB (the hook's
 * container_state write is try/caught by design).
 */
import { describe, expect, it } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, buildDisallowedTools, createPreToolUseHook } from './claude.js';

type LooseHook = (input: unknown) => Promise<Record<string, unknown>>;

describe('buildDisallowedTools', () => {
  it('fails closed: absent/empty/off/garbage all include Workflow plus the fixed set', () => {
    for (const caps of [undefined, {}, { workflow: 'off' }, { workflow: 'garbage' }]) {
      const list = buildDisallowedTools(caps);
      for (const fixed of SDK_DISALLOWED_TOOLS) expect(list).toContain(fixed);
      expect(list).toContain('Workflow');
      expect(list).toContain('DesignSync');
      expect(list).toContain('ReportFindings');
    }
  });

  it('workflow=on removes only Workflow', () => {
    const list = buildDisallowedTools({ workflow: 'on' });
    expect(list).not.toContain('Workflow');
    expect(list).toContain('DesignSync');
    expect(list).toContain('CronCreate');
  });

  it('agent-teams has no runner mechanism and never changes the list', () => {
    expect(buildDisallowedTools({ 'agent-teams': 'on' })).toEqual(buildDisallowedTools({ 'agent-teams': 'off' }));
  });
});

describe('createPreToolUseHook', () => {
  it('blocks a listed tool with the nanoclaw-equivalent message', async () => {
    const hook = createPreToolUseHook(['Workflow']) as unknown as LooseHook;
    const res = await hook({ tool_name: 'Workflow', tool_input: {} });
    expect(res.decision).toBe('block');
    expect(String(res.stopReason)).toContain('nanoclaw equivalent');
  });

  it('passes an unlisted tool through', async () => {
    const hook = createPreToolUseHook(['Workflow']) as unknown as LooseHook;
    const res = await hook({ tool_name: 'Bash', tool_input: { timeout: 1000 } });
    expect(res.continue).toBe(true);
  });
});
