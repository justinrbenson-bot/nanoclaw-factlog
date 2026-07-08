/**
 * Harness-capability registry: which harness-native features NanoClaw exposes
 * as per-group toggles, and their code defaults.
 *
 * Policy lives here on the host; mechanism lives provider-side in the agent
 * runner. Per-group overrides are a sparse JSON map in
 * `container_configs.harness_capabilities`; the RESOLVED map (defaults ⊕
 * overrides) is what gets materialized into container.json and applied to the
 * group's settings.json by the reconciler in group-init.ts. Fixed-off
 * capabilities (scheduling, ask-user, plan/worktree, DesignSync) are not keys
 * here by design — a toggle nobody can meaningfully use is surface without
 * value. See docs/harness-capabilities.md.
 */
import { log } from './log.js';

export type HarnessCapabilityState = 'on' | 'off';

/**
 * Configurable keys and their defaults. Adding a key is additive — no schema
 * change. Keys are lowercase kebab-case; both toggles default OFF because
 * NanoClaw's own systems (a2a messaging, host-side orchestration) are the
 * authoritative equivalents.
 */
export const HARNESS_CAPABILITY_DEFAULTS: Record<string, HarnessCapabilityState> = {
  'agent-teams': 'off',
  workflow: 'off',
};

const VALID_STATES = new Set<string>(['on', 'off']);

/**
 * Resolve a group's stored override JSON against the code defaults.
 *
 * Malformed JSON degrades to defaults with a warning rather than throwing:
 * unlike structural config (mcp_servers, mounts), capabilities have a safe
 * fallback, and the only sanctioned write path (ncl) validates its input.
 * Unknown keys pass through untouched (with a warning) so the runner's own
 * unknown-key diagnostics stay exercised; known keys with garbage values
 * fall back to their default.
 */
export function resolveHarnessCapabilities(
  overridesJson: string | null | undefined,
): Record<string, HarnessCapabilityState> {
  let overrides: Record<string, unknown> = {};
  if (overridesJson) {
    try {
      const parsed: unknown = JSON.parse(overridesJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = parsed as Record<string, unknown>;
      } else {
        log.warn('harness_capabilities is not a JSON object — using defaults', { value: overridesJson });
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      log.warn('harness_capabilities is malformed JSON — using defaults', { value: overridesJson });
    }
  }

  const resolved: Record<string, HarnessCapabilityState> = { ...HARNESS_CAPABILITY_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in HARNESS_CAPABILITY_DEFAULTS)) {
      log.warn('Unknown harness capability key in overrides — passing through', { key });
      resolved[key] = value as HarnessCapabilityState;
      continue;
    }
    if (typeof value !== 'string' || !VALID_STATES.has(value)) {
      log.warn('Invalid harness capability value — using default', { key, value });
      continue;
    }
    resolved[key] = value as HarnessCapabilityState;
  }
  return resolved;
}

export interface HarnessCapabilityOps {
  set: Record<string, HarnessCapabilityState>;
  clear: string[];
}

/**
 * Parse the ncl `--harness-capabilities` flag value: comma-separated `k=v`
 * pairs where v is `on`, `off`, or `default` (`default` clears the override —
 * it is never stored). Keys are normalized (trim, lowercase, `_`→`-`) and
 * validated against the registry. Throws with an actionable message on the
 * first problem.
 */
export function parseHarnessCapabilitiesArg(input: string): HarnessCapabilityOps {
  const allowed = Object.keys(HARNESS_CAPABILITY_DEFAULTS).join(', ');
  const ops: HarnessCapabilityOps = { set: {}, clear: [] };
  const pairs = input
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pairs.length === 0) {
    throw new Error(`--harness-capabilities requires one or more key=value pairs (keys: ${allowed})`);
  }
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new Error(`--harness-capabilities entry "${pair}" must be key=value (on|off|default)`);
    }
    const key = pair.slice(0, eq).trim().toLowerCase().replace(/_/g, '-');
    const value = pair
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (!(key in HARNESS_CAPABILITY_DEFAULTS)) {
      throw new Error(`unknown harness capability "${key}" — configurable keys: ${allowed}`);
    }
    if (value === 'default') {
      ops.clear.push(key);
    } else if (VALID_STATES.has(value)) {
      ops.set[key] = value as HarnessCapabilityState;
    } else {
      throw new Error(`harness capability "${key}" must be on, off, or default — got "${value}"`);
    }
  }
  return ops;
}
