/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
  /** Resolved harness-capability map (host-resolved). Missing → legacy all-on (pre-capability host). */
  harnessCapabilities: Record<string, string>;
}

const DEFAULT_MAX_MESSAGES = 10;

// Pre-capability behavior. A container.json without `harnessCapabilities` was
// written by an older host (capability-aware hosts always emit the full
// resolved map, never omit it) — and under that host every group ran with
// teams + Workflow on. Defaulting to {} here would regress those groups to
// all-off during the update window where the bind-mounted runner source is
// already new but the still-running old host wrote the config file.
const LEGACY_HARNESS_CAPABILITIES: Record<string, string> = { 'agent-teams': 'on', workflow: 'on' };

let _config: RunnerConfig | null = null;

/** Map raw container.json fields to a RunnerConfig, applying per-field defaults. */
export function configFromRaw(raw: Record<string, unknown>): RunnerConfig {
  return {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    harnessCapabilities: (raw.harnessCapabilities as Record<string, string>) ?? LEGACY_HARNESS_CAPABILITIES,
  };
}

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = configFromRaw(raw);
  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
