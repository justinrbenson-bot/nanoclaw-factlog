import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import type { HarnessCapabilityState } from './harness-capabilities.js';
import type { AgentGroup } from './types.js';

// Managed harness keys (the teams env key, disableWorkflows) are deliberately
// NOT in the static default — they enter settings.json exclusively through
// reconcileHarnessSettings() from the group's resolved capability state.
const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

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
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
      initialized.push('settings.json');
    } else {
      ensurePreCompactHook(settingsFile, initialized);
    }

    // Runs in BOTH branches: a freshly written default must be reconciled in
    // the same call, or the group's first container lifetime ships without
    // its capability state (the default file deliberately omits managed keys).
    if (opts?.harnessCapabilities) {
      reconcileHarnessSettings(settingsFile, opts.harnessCapabilities, initialized);
    }

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

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';

/**
 * Patch an existing settings.json to add the PreCompact hook if missing.
 * Runs on every group init so pre-existing groups pick up the hook.
 */
function ensurePreCompactHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Check if there's already a PreCompact hook with our command.
    const existing = settings.hooks?.PreCompact as unknown[] | undefined;
    if (existing && JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;

    // Add the hook, preserving existing hooks.
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    settings.hooks.PreCompact.push({
      hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }],
    });

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json (added PreCompact hook)');
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}

const TEAMS_ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

/**
 * Reconcile the managed harness-capability keys in settings.json to the
 * group's resolved capability state. Manages exactly two keys — the
 * agent-teams env key and `disableWorkflows` — adding AND removing them;
 * everything else in the file (operator hand-edits, the PreCompact hook,
 * unmanaged env keys) is preserved verbatim. Runs on every spawn, so
 * pre-existing groups converge to the configured state, including removal
 * of the legacy always-on teams key. See docs/harness-capabilities.md.
 */
function reconcileHarnessSettings(
  settingsFile: string,
  caps: Record<string, HarnessCapabilityState>,
  initialized: string[],
): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown> & { env?: Record<string, unknown> };

    // agent-teams: the settings env key is the ONLY working switch on the
    // pinned CLI — settings env strictly beats SDK options env, so presence
    // in this file IS the state.
    if (caps['agent-teams'] === 'on') {
      if (!settings.env) settings.env = {};
      settings.env[TEAMS_ENV_KEY] = '1';
    } else if (settings.env && TEAMS_ENV_KEY in settings.env) {
      delete settings.env[TEAMS_ENV_KEY];
    }

    // workflow: disableWorkflows removes the Workflow tool AND its agent-types
    // catalog block from every request. The runner's disallowedTools backstop
    // covers a malformed or hand-reverted file — that backstop is what makes
    // the warn-and-continue below acceptable.
    if (caps.workflow === 'off') {
      settings.disableWorkflows = true;
    } else if ('disableWorkflows' in settings) {
      delete settings.disableWorkflows;
    }

    const next = JSON.stringify(settings, null, 2) + '\n';
    if (next === raw) return; // no churn on the every-spawn path

    // tmp+rename: two sessions of one group can spawn concurrently; both
    // compute identical output from the same DB row, so last-rename-wins is
    // harmless — but a torn write mid-read by the CLI would not be.
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, settingsFile);
    initialized.push('settings.json (reconciled harness capabilities)');
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    log.warn('settings.json is malformed — skipping harness-capability reconcile', { settingsFile });
  }
}
