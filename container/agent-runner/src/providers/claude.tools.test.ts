/**
 * Drift guard for the harness tool surface. sdk-tools-baseline.json is a wire
 * capture of every tool the pinned CLI can offer under our configuration
 * (regenerate with dump-sdk-tools.ts — instructions in its header). These
 * tests catch upstream renames/removals when the claude-code pin moves:
 * bumping container/cli-tools.json fails the version assertion until the
 * fixture is regenerated and the lists below are re-verified.
 */
import fs from 'fs';

import { describe, expect, it } from 'bun:test';

import cliTools from '../../../cli-tools.json';
import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude.js';
import baseline from './sdk-tools-baseline.json';

/**
 * Disallow entries that do NOT exist on the pinned CLI in headless SDK mode
 * (wire-verified: never offered, in both string and streaming input modes).
 * Kept in SDK_DISALLOWED_TOOLS as drift insurance — if an upstream version
 * starts offering one, the fixture regeneration surfaces it here and the
 * entry moves out of this set.
 */
const KNOWN_ABSENT_DISALLOWED = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

const installedSdkVersion = (
  JSON.parse(
    fs.readFileSync(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

const baselineTools = new Set<string>(baseline.tools);

describe('sdk tool-surface drift guard', () => {
  it('fixture matches the pinned claude-code CLI version', () => {
    const pin = cliTools.find((t) => t.name === '@anthropic-ai/claude-code')?.version;
    expect(baseline.cliVersion).toBe(pin);
  });

  it('fixture matches the installed Agent SDK version', () => {
    // The SDK is a caret-free pinned dep; a bump must be captured deliberately.
    expect(baseline.sdkVersion).toBe(installedSdkVersion);
  });

  it('allowedTools is inert: the production allowlist and the bare surface match', () => {
    // Wire-verified invariant — passing TOOL_ALLOWLIST neither filters nor
    // promotes any tool under bypassPermissions. If a future CLI makes
    // allowedTools an availability filter, these diverge and this fails.
    expect([...baseline.tools].sort()).toEqual([...baseline.toolsBare].sort());
  });

  it('every allowlist entry names a real tool on this surface', () => {
    for (const name of TOOL_ALLOWLIST) {
      expect(baselineTools.has(name), `allowlist entry '${name}' not in captured surface`).toBe(true);
    }
  });

  it('every disallow entry is either a real tool or documented drift insurance', () => {
    for (const name of SDK_DISALLOWED_TOOLS) {
      const real = baselineTools.has(name);
      const insurance = KNOWN_ABSENT_DISALLOWED.includes(name);
      expect(
        real || insurance,
        `disallow entry '${name}' is neither on the surface nor in KNOWN_ABSENT_DISALLOWED`,
      ).toBe(true);
    }
  });

  it('drift-insurance entries are still absent from the surface', () => {
    for (const name of KNOWN_ABSENT_DISALLOWED) {
      expect(
        baselineTools.has(name),
        `'${name}' now exists on the surface — move it out of KNOWN_ABSENT_DISALLOWED and re-verify its disposition`,
      ).toBe(false);
    }
  });

  it('capability-managed tools exist on the surface', () => {
    // Workflow (the `workflow` capability) and DesignSync (fixed-off) must be
    // real tools for the disallow/settings mechanisms to be doing anything.
    for (const name of ['Workflow', 'DesignSync']) {
      expect(baselineTools.has(name), `'${name}' vanished from the surface — re-audit its capability mapping`).toBe(
        true,
      );
    }
  });
});
