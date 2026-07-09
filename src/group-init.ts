import fs from 'fs';
import path from 'path';

import { writeAtomic } from './claude-md-compose.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { HARNESS_CAPABILITIES } from './harness-capabilities.js';
import { log } from './log.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { HarnessCapabilityState } from './harness-capabilities.js';
import type { AgentGroup } from './types.js';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';

// Base settings for a brand-new group. Managed harness keys (the teams env key,
// disableWorkflows) are deliberately NOT here — they enter settings.json
// exclusively through the reconciler from the group's resolved capability state,
// applied on top of this base in the same write.
const DEFAULT_SETTINGS = {
  env: {
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
  hooks: {
    PreCompact: [{ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] }],
  },
};

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(
  group: AgentGroup,
  opts?: {
    instructions?: string;
    provider?: string | null;
    /** RESOLVED harness-capability map — when provided (the spawn path), settings.json is reconciled to it. */
    harnessCapabilities?: Record<string, HarnessCapabilityState>;
  },
): void {
  const initialized: string[] = [];

  // Default agent surfaces apply unless the group's provider declares (at
  // registration) that it provides its own. Callers that don't know the
  // provider omit it — unregistered/unknown names report no capabilities,
  // so the default surfaces are written, exactly as before this seam.
  const defaultSurfaces = !providerProvidesAgentSurfaces(opts?.provider);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // Seed instructions land in the provider's OWN memory surface. Default
  // (Claude) surfaces auto-load CLAUDE.local.md natively. A surfaces-owning
  // provider must never see stale CLAUDE.* files in its workspace — its seed
  // goes into the memory scaffold's conventional landing file instead
  // (memory/memories/imported-agent-memory.md): the container-side scaffold
  // preserves pre-existing files, and the doctrine tells the agent to read
  // that file on its first turn.
  //
  // Creation stays provider-agnostic: a DM-agent creator drops the seed in a
  // neutral `.seed.md`, and placement is deferred to here (the first spawn,
  // where the DB-resolved provider is known). Once placed it's consumed.
  // `opts.instructions` still wins for any caller that passes it inline.
  const neutralSeedFile = path.join(groupDir, '.seed.md');
  const seed =
    opts?.instructions ??
    (fs.existsSync(neutralSeedFile) ? fs.readFileSync(neutralSeedFile, 'utf-8').trimEnd() : undefined);

  if (defaultSurfaces) {
    const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
    if (!fs.existsSync(claudeLocalFile)) {
      fs.writeFileSync(claudeLocalFile, seed ? seed + '\n' : '');
      initialized.push('CLAUDE.local.md');
    }
  } else if (seed) {
    const seedFile = path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md');
    if (!fs.existsSync(seedFile)) {
      fs.mkdirSync(path.dirname(seedFile), { recursive: true });
      fs.writeFileSync(seedFile, seed + '\n');
      initialized.push('memory/memories/imported-agent-memory.md');
    }
  }

  // The neutral seed is single-use — drop it once the surface it belonged in
  // has been resolved, so it can't re-seed after the operator edits theirs.
  if (fs.existsSync(neutralSeedFile)) {
    fs.rmSync(neutralSeedFile);
    initialized.push('.seed.md consumed');
  }

  // Ensure container_configs row exists in the DB. Idempotent — no-op if
  // the row already exists (e.g. created by backfill or group creation).
  ensureContainerConfig(group.id);
  initialized.push('container_configs');

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  if (defaultSurfaces) {
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      initialized.push('.claude-shared');
    }

    const settingsFile = path.join(claudeDir, 'settings.json');
    applyGroupSettings(settingsFile, opts?.harnessCapabilities, initialized);

    // Skills directory — created empty here; symlinks are synced at spawn
    // time by container-runner.ts based on container.json skills selection.
    const skillsDst = path.join(claudeDir, 'skills');
    if (!fs.existsSync(skillsDst)) {
      fs.mkdirSync(skillsDst, { recursive: true });
      initialized.push('skills/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}

type SettingsObject = Record<string, unknown>;

function asObject(value: unknown): SettingsObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SettingsObject) : null;
}

/**
 * Bring a group's settings.json to its desired state in a single read-modify-
 * write: ensure the PreCompact hook is present and reconcile the managed
 * harness-capability keys to `caps`. A fresh file is composed from
 * DEFAULT_SETTINGS + the capability keys in one atomic write; an existing file
 * is mutated in memory and rewritten only if it changed. Any content that isn't
 * a JSON object (malformed, `null`, a scalar, an array) is left untouched with
 * a warning — settings trouble must never break group init or block a spawn.
 */
function applyGroupSettings(
  settingsFile: string,
  caps: Record<string, HarnessCapabilityState> | undefined,
  initialized: string[],
): void {
  if (!fs.existsSync(settingsFile)) {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SettingsObject;
    reconcileHarnessKeys(settings, caps);
    writeAtomic(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json');
    return;
  }

  let raw: string;
  let parsed: unknown;
  try {
    raw = fs.readFileSync(settingsFile, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    log.warn('settings.json is malformed — leaving it untouched', { settingsFile });
    return;
  }
  const settings = asObject(parsed);
  if (!settings) {
    log.warn('settings.json is not a JSON object — leaving it untouched', { settingsFile });
    return;
  }

  ensurePreCompactHook(settings);
  reconcileHarnessKeys(settings, caps);

  const next = JSON.stringify(settings, null, 2) + '\n';
  if (next === raw) return; // no churn on the every-spawn path
  writeAtomic(settingsFile, next);
  initialized.push('settings.json (updated)');
}

/** Ensure the PreCompact archiving hook is present, preserving existing hooks. */
function ensurePreCompactHook(settings: SettingsObject): void {
  const hooks = asObject(settings.hooks) ?? (settings.hooks = {});
  const existing = Array.isArray(hooks.PreCompact) ? (hooks.PreCompact as unknown[]) : (hooks.PreCompact = []);
  if (JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;
  existing.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
}

/**
 * Reconcile the managed harness-capability keys to `caps`, iterating the
 * registry's host mechanisms — adding AND removing each key so pre-existing
 * groups converge (including removal of the legacy always-on teams key).
 * Everything unmanaged in the file is preserved. `caps` undefined (non-spawn
 * callers) leaves capability keys untouched.
 */
function reconcileHarnessKeys(
  settings: SettingsObject,
  caps: Record<string, HarnessCapabilityState> | undefined,
): void {
  if (!caps) return;
  for (const [key, def] of Object.entries(HARNESS_CAPABILITIES)) {
    const state = caps[key] ?? def.default;
    const m = def.host;
    if (m.kind === 'env') {
      // Presence of the env key IS the on-state.
      if (state === 'on') {
        const env = asObject(settings.env) ?? (settings.env = {});
        env[m.key] = '1';
      } else {
        const env = asObject(settings.env);
        if (env && m.key in env) delete env[m.key];
      }
    } else {
      // disableFlag: the flag is set true when the capability is OFF.
      if (state === 'off') settings[m.key] = true;
      else if (m.key in settings) delete settings[m.key];
    }
  }
}
