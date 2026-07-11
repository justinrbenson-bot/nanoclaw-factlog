/**
 * factlog integration — host side (docs/factlog.md).
 *
 * NanoClaw's isolation principle costs agents shared memory. This module adds
 * the missing middle: the factlog daemon's fact log as the single, narrow,
 * auditable channel between containers. At spawn time the host:
 *
 *   1. mints a per-run actor token via the factlog CLI (`token mint` prints
 *      the secret to stdout, designed to be piped into a container launch) —
 *      the daemon stamps every write's actor server-side from this token, so
 *      containers cannot spoof authorship;
 *   2. writes the run identity file into the session dir (visible in-container
 *      at /workspace/factlog.json, read by the agent-runner at boot);
 *   3. contributes the daemon's unix socket as a bind mount at
 *      /run/factlog.sock (`socket` transport) — an explicit, inspectable
 *      grant, consistent with "agents only see what's mounted".
 *
 * Trust (integration design §6): runs are tainted `origin: external` unless
 * the group's factlog.json says otherwise — every nanoclaw agent processes
 * inbound channel content, so facts it posts carry meta["x-origin"]="external"
 * and any `decision`/`invariant` is held pending until a human approves.
 *
 * Failure posture: best-effort. A mint/write failure logs a warning and the
 * container spawns without factlog — coordination is an amenity, message
 * delivery is the product.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  FACTLOG_BIN,
  FACTLOG_CATALOG_URL,
  FACTLOG_HOST_URL,
  FACTLOG_SOCKET,
  FACTLOG_TRANSPORT,
  FACTLOG_WORKSPACE,
  GROUPS_DIR,
} from '../../config.js';
import { log } from '../../log.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup } from '../../types.js';

const execFileAsync = promisify(execFile);

/** Where the socket appears inside every container. */
export const CONTAINER_SOCKET_PATH = '/run/factlog.sock';

/** Token lifetime — bounded by the run, belt-and-braces revoked on exit. */
const TOKEN_TTL_SECONDS = 86_400;

/**
 * Per-group scope declaration, `groups/<folder>/factlog.json` (host-managed,
 * like CLAUDE.md — the nested RO story doesn't apply because the file is
 * read host-side only; the container sees the derived run identity instead).
 */
export interface FactlogGroupConfig {
  /** What the agent's brief covers (uris and/or path globs). Absent = global. */
  homeScopes?: string[];
  /**
   * Catalog blocks assigned to this agent — its slice of the classified log.
   * When set, the run also pulls a block-scoped brief from the factlog-catalog
   * serve endpoint (alongside the scope brief), so an agent can wake on a
   * curated cross-scope block instead of raw scope globs. Absent = no block
   * brief. See docs/factlog.md and the factlog-catalog project.
   */
  homeBlocks?: string[];
  /** Where the agent may post. Enforced daemon-side via the minted token. */
  writeScopes?: string[];
  /**
   * Taint marker for the run's writes. Defaults to 'external' — see module
   * header. 'internal' is an explicit operator override for groups that never
   * touch untrusted content.
   */
  origin?: 'external' | 'internal';
  /** Actor sponsor recorded on every fact (e.g. the owning human). */
  sponsor?: string;
}

/** The run identity file the agent-runner reads at /workspace/factlog.json. */
export interface FactlogRunIdentity {
  transport: 'socket' | 'http';
  /** In-container socket path (`socket` transport). */
  socket?: string;
  /** Daemon base URL (`http` transport, host-gateway). */
  url?: string;
  token: string;
  agent: string;
  session: string;
  homeScopes?: string[];
  /** Blocks for this run's block-scoped brief (see FactlogGroupConfig). */
  homeBlocks?: string[];
  /** factlog-catalog serve base URL — only present when homeBlocks is set. */
  catalogUrl?: string;
  writeScopes?: string[];
}

export interface FactlogRun {
  /** Extra container mounts (the daemon socket, when transport is `socket`). */
  mounts: VolumeMount[];
  /**
   * Extra container env. The OneCLI gateway wires the container's HTTP(S)
   * proxy to itself (`NODE_USE_ENV_PROXY=1` + `http_proxy`) with no loopback
   * bypass, which otherwise routes the SDK's connection to the in-container
   * factlog loopback proxy — and that proxy's own upstream to the daemon —
   * *through* the gateway, so the HTTP MCP server silently never connects.
   * NO_PROXY exempts loopback (and the docker host, for `host-gateway`
   * transport). External API hosts stay proxied, so credential injection is
   * unaffected.
   */
  env: Record<string, string>;
}

/**
 * Hosts the factlog loopback proxy (127.0.0.1) and, on `host-gateway`
 * transport, the daemon itself (host.docker.internal). These must bypass the
 * OneCLI HTTP proxy or the factlog MCP connection dies. Harmless on `socket`
 * transport (the daemon is a unix socket, never proxied).
 */
const NO_PROXY_BYPASS = '127.0.0.1,localhost,host.docker.internal';

/** token secrets by container name, for best-effort revocation on exit. */
const runTokens = new Map<string, string>();

export function factlogEnabled(): boolean {
  return FACTLOG_WORKSPACE !== '' && fs.existsSync(path.join(FACTLOG_WORKSPACE, '.factlog'));
}

export function loadFactlogGroupConfig(groupFolder: string): FactlogGroupConfig {
  const file = path.join(GROUPS_DIR, groupFolder, 'factlog.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FactlogGroupConfig;
  } catch {
    return {};
  }
}

/**
 * Mint the run token and write the identity file. Returns the mounts to add,
 * or null when factlog is disabled or preparation failed (spawn proceeds
 * without factlog either way).
 */
export async function prepareFactlogRun(
  agentGroup: AgentGroup,
  containerName: string,
  sessionDirPath: string,
): Promise<FactlogRun | null> {
  if (!factlogEnabled()) return null;

  const groupConfig = loadFactlogGroupConfig(agentGroup.folder);
  try {
    const token = await mintToken(agentGroup, containerName, groupConfig);
    runTokens.set(containerName, token);

    const identity: FactlogRunIdentity = {
      ...(FACTLOG_TRANSPORT === 'socket'
        ? { transport: 'socket' as const, socket: CONTAINER_SOCKET_PATH }
        : { transport: 'http' as const, url: FACTLOG_HOST_URL }),
      token,
      agent: agentGroup.folder,
      session: containerName,
      ...(groupConfig.homeScopes !== undefined ? { homeScopes: groupConfig.homeScopes } : {}),
      // Block brief only wires when both the group declares homeBlocks and a
      // catalog URL is configured — otherwise the field is inert plumbing.
      ...(groupConfig.homeBlocks !== undefined && groupConfig.homeBlocks.length > 0 && FACTLOG_CATALOG_URL !== ''
        ? { homeBlocks: groupConfig.homeBlocks, catalogUrl: FACTLOG_CATALOG_URL }
        : {}),
      ...(groupConfig.writeScopes !== undefined ? { writeScopes: groupConfig.writeScopes } : {}),
    };
    fs.writeFileSync(path.join(sessionDirPath, 'factlog.json'), `${JSON.stringify(identity, null, 2)}\n`, {
      mode: 0o600,
    });

    const mounts: VolumeMount[] = [];
    if (FACTLOG_TRANSPORT === 'socket') {
      if (!fs.existsSync(FACTLOG_SOCKET)) {
        throw new Error(`daemon socket not found at ${FACTLOG_SOCKET} — is \`factlog serve\` running?`);
      }
      // RW: connecting to a unix socket needs write access to the inode.
      mounts.push({ hostPath: FACTLOG_SOCKET, containerPath: CONTAINER_SOCKET_PATH, readonly: false });
    }

    log.info('factlog run prepared', {
      containerName,
      agent: agentGroup.folder,
      transport: FACTLOG_TRANSPORT,
      origin: groupConfig.origin ?? 'external',
    });
    return { mounts, env: { NO_PROXY: NO_PROXY_BYPASS, no_proxy: NO_PROXY_BYPASS } };
  } catch (err) {
    runTokens.delete(containerName);
    log.warn('factlog run preparation failed — container spawns without factlog', { containerName, err });
    return null;
  }
}

/** Revoke the run's token. Best-effort; the TTL bounds a missed revocation. */
export function releaseFactlogRun(containerName: string): void {
  const token = runTokens.get(containerName);
  if (token === undefined) return;
  runTokens.delete(containerName);
  execFile(FACTLOG_BIN, ['token', 'revoke', token], { cwd: FACTLOG_WORKSPACE }, (err) => {
    if (err) log.warn('factlog token revoke failed (TTL will expire it)', { containerName, err });
  });
}

async function mintToken(
  agentGroup: AgentGroup,
  containerName: string,
  groupConfig: FactlogGroupConfig,
): Promise<string> {
  const args = [
    'token',
    'mint',
    '--agent',
    agentGroup.folder,
    '--session',
    containerName,
    '--ttl',
    String(TOKEN_TTL_SECONDS),
  ];
  if (groupConfig.sponsor !== undefined) args.push('--sponsor', groupConfig.sponsor);
  // Taint at the source (§6.1): default external; the daemon then stamps
  // meta["x-origin"]="external" on every write and holds decision/invariant
  // posts pending human approval. The client cannot unset it.
  if ((groupConfig.origin ?? 'external') === 'external') args.push('--origin', 'external');
  if (groupConfig.writeScopes !== undefined && groupConfig.writeScopes.length > 0) {
    args.push('--write-scope', ...groupConfig.writeScopes);
  }
  const { stdout } = await execFileAsync(FACTLOG_BIN, args, { cwd: FACTLOG_WORKSPACE, timeout: 15_000 });
  const token = stdout.trim();
  if (!token.startsWith('flt_')) throw new Error(`unexpected mint output: ${token.slice(0, 40)}`);
  return token;
}
