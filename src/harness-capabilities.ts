/**
 * Harness-capability registry: which harness-native features NanoClaw exposes
 * as per-group toggles, their code defaults, and how the host applies each one
 * to a group's settings.json.
 *
 * This is the single host-side source of truth. Per-group overrides are a
 * sparse JSON map in `container_configs.harness_capabilities`; the RESOLVED map
 * (defaults ⊕ overrides) is materialized into container.json and applied to the
 * group's settings.json by the reconciler in group-init.ts, which iterates the
 * `host` mechanism of every entry below — so adding a capability is one entry
 * here plus (if it also needs a runtime tool block) one line in the runner's
 * CAPABILITY_DISALLOWS map. Fixed-off capabilities (scheduling, ask-user,
 * plan/worktree, DesignSync) are not keys here by design — a toggle nobody can
 * meaningfully use is surface without value. See docs/harness-capabilities.md.
 */
import { log } from './log.js';

export type HarnessCapabilityState = 'on' | 'off';

/**
 * How the settings reconciler expresses a capability in settings.json.
 * - `env`: the presence of an env key IS the on-state (the key is written when
 *   on, deleted when off). Verified on the pinned CLI: settings env strictly
 *   beats SDK options env, so this file is the only working switch.
 * - `disableFlag`: a top-level boolean set `true` when the capability is OFF
 *   (disable-style flag), deleted when on.
 */
export type HostMechanism = { kind: 'env'; key: string } | { kind: 'disableFlag'; key: string };

export interface CapabilityDef {
  default: HarnessCapabilityState;
  host: HostMechanism;
}

/**
 * Configurable capabilities. Both default OFF because NanoClaw's own systems
 * (a2a messaging, host-side orchestration) are the authoritative equivalents.
 */
export const HARNESS_CAPABILITIES: Record<string, CapabilityDef> = {
  'agent-teams': { default: 'off', host: { kind: 'env', key: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' } },
  workflow: { default: 'off', host: { kind: 'disableFlag', key: 'disableWorkflows' } },
};

export const HARNESS_CAPABILITY_KEYS = Object.keys(HARNESS_CAPABILITIES);

/** Derived key→default map, for callers that only need the defaults. */
export const HARNESS_CAPABILITY_DEFAULTS: Record<string, HarnessCapabilityState> = Object.fromEntries(
  Object.entries(HARNESS_CAPABILITIES).map(([key, def]) => [key, def.default]),
);

const VALID_STATES = new Set<string>(['on', 'off']);

function isKnownKey(key: string): boolean {
  return Object.hasOwn(HARNESS_CAPABILITIES, key);
}

// Durable bad state (a stale key or garbage value persisted in the DB) would
// otherwise log on every spawn — under scheduled-task wakes, forever. Warn once
// per distinct problem per host process instead, so real warnings aren't buried.
const warnedOnce = new Set<string>();
function warnOnce(signature: string, message: string, data: Record<string, unknown>): void {
  if (warnedOnce.has(signature)) return;
  warnedOnce.add(signature);
  log.warn(message, data);
}

/**
 * Parse a group's stored override JSON into the raw sparse map. Malformed or
 * non-object JSON degrades to {} with a warning rather than throwing: unlike
 * structural config (mcp_servers, mounts), capabilities have a safe fallback,
 * and the only sanctioned write path (ncl) validates its input.
 */
export function parseHarnessOverrides(overridesJson: string | null | undefined): Record<string, unknown> {
  if (!overridesJson) return {};
  try {
    const parsed: unknown = JSON.parse(overridesJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnOnce(`shape:${overridesJson}`, 'harness_capabilities is not a JSON object — using defaults', {
      value: overridesJson,
    });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    warnOnce(`syntax:${overridesJson}`, 'harness_capabilities is malformed JSON — using defaults', {
      value: overridesJson,
    });
  }
  return {};
}

/**
 * Resolve stored overrides (JSON string, or an already-parsed map) against the
 * code defaults. Unknown keys and invalid values are dropped (they fall back to
 * defaults) so the resolved map only ever contains known keys with valid
 * states — the runner therefore never has to reason about unknown keys.
 */
export function resolveHarnessCapabilities(
  overrides: string | Record<string, unknown> | null | undefined,
): Record<string, HarnessCapabilityState> {
  const raw = typeof overrides === 'string' || overrides == null ? parseHarnessOverrides(overrides) : overrides;

  const resolved: Record<string, HarnessCapabilityState> = { ...HARNESS_CAPABILITY_DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (!isKnownKey(key)) {
      warnOnce(`unknown:${key}`, 'Unknown harness capability key in overrides — dropping', { key });
      continue;
    }
    if (typeof value !== 'string' || !VALID_STATES.has(value)) {
      warnOnce(`value:${key}:${String(value)}`, 'Invalid harness capability value — using default', { key, value });
      continue;
    }
    resolved[key] = value as HarnessCapabilityState;
  }
  return resolved;
}

/**
 * Parse the ncl `--harness-capabilities` flag value: comma-separated `k=v`
 * pairs where v is `on`, `off`, or `default` (`default` clears the override —
 * it is never stored). Keys are normalized (trim, lowercase, `_`→`-`) and
 * validated against the registry. Returns a plain key→directive map, so a
 * repeated key resolves last-wins by ordinary assignment. Throws with an
 * actionable message on the first problem.
 */
export function parseHarnessCapabilitiesArg(input: string): Record<string, HarnessCapabilityState | 'default'> {
  const allowed = HARNESS_CAPABILITY_KEYS.join(', ');
  const out: Record<string, HarnessCapabilityState | 'default'> = {};
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
    if (!isKnownKey(key)) {
      throw new Error(`unknown harness capability "${key}" — configurable keys: ${allowed}`);
    }
    if (value === 'default' || VALID_STATES.has(value)) {
      out[key] = value as HarnessCapabilityState | 'default';
    } else {
      throw new Error(`harness capability "${key}" must be on, off, or default — got "${value}"`);
    }
  }
  return out;
}
