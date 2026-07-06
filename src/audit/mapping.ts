/**
 * Event assembly — actors, origins, action names, resources, and the
 * per-surface details rules (including shape-only for message-bearing
 * payloads). Pure derivation; nothing here writes the log.
 */
import os from 'os';

import { getResource } from '../cli/crud.js';
import type { CallerContext, RequestFrame } from '../cli/frame.js';
import { type CommandDef, lookup } from '../cli/registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import type { Session } from '../types.js';
import { type AuditActor, type AuditEventInput, type AuditOrigin, type AuditResource, SYSTEM_ACTOR } from './types.js';

// ── Actors ──

function hostUser(): string {
  try {
    return os.userInfo().username;
    // eslint-disable-next-line no-catch-all/no-catch-all -- os.userInfo throws on exotic hosts; a fallback actor id beats no audit event
  } catch {
    return process.env.USER || 'unknown';
  }
}

/**
 * Host callers stamp `host:<install user>` daemon-side: the ncl socket is
 * 0600 and owned by the install user, so the identity is accurate by
 * construction without peer credentials.
 */
export function actorForCaller(ctx: CallerContext): AuditActor {
  return ctx.caller === 'host' ? { type: 'human', id: `host:${hostUser()}` } : { type: 'agent', id: ctx.agentGroupId };
}

/** Empty resolver id (sweep/timer paths) → the system actor. */
export function humanOrSystemActor(namespacedUserId: string): AuditActor {
  return namespacedUserId ? { type: 'human', id: namespacedUserId } : SYSTEM_ACTOR;
}

// ── Origins ──

export function originForCaller(ctx: CallerContext): AuditOrigin {
  if (ctx.caller === 'host') return { transport: 'socket' };
  return containerOrigin(ctx.sessionId, ctx.messagingGroupId || null);
}

export function originForSession(session: Session): AuditOrigin {
  return containerOrigin(session.id, session.messaging_group_id);
}

function containerOrigin(sessionId: string, messagingGroupId: string | null): AuditOrigin {
  const origin: AuditOrigin = { transport: 'container', session_id: sessionId };
  if (messagingGroupId) {
    origin.messaging_group_id = messagingGroupId;
    const channel = getMessagingGroup(messagingGroupId)?.channel_type;
    if (channel) origin.channel = channel;
  }
  return origin;
}

/** Approval decisions arrive as card clicks on a chat platform. */
export function channelOriginForUser(namespacedUserId: string): AuditOrigin {
  const idx = namespacedUserId.indexOf(':');
  const channel = idx > 0 ? namespacedUserId.slice(0, idx) : undefined;
  return channel ? { transport: 'channel', channel } : { transport: 'channel' };
}

// ── CLI resources ──

/**
 * Frame-level args use `--hyphen-keys`; recorded details use the same
 * underscore form the parsed handlers see. Mirrors crud's normalizeArgs
 * (kept local so audit doesn't depend on a module tests commonly mock).
 */
export function normalizeArgKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-/g, '_')] = v;
  }
  return out;
}

/** CLI resource plural → audit resource type, where the singular isn't it. */
const RESOURCE_TYPE_OVERRIDES: Record<string, string> = {
  groups: 'agent_group',
  'messaging-groups': 'messaging_group',
  'dropped-messages': 'dropped_message',
  'user-dms': 'user_dm',
};

/**
 * Derive touched/attempted resources from a command's effective args. Generic
 * by design: `id` → the command's own resource, group/user args → their
 * types, and a bare `{type}` entry when nothing else is known (a denied
 * `users list` still names what was attempted).
 */
export function resourcesForCli(cmd: CommandDef, args: Record<string, unknown>): AuditResource[] {
  if (!cmd.resource) return [];
  const type = RESOURCE_TYPE_OVERRIDES[cmd.resource] ?? getResource(cmd.resource)?.name ?? cmd.resource;

  const out: AuditResource[] = [];
  const push = (t: string, id: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    if (!out.some((r) => r.type === t && r.id === id)) out.push({ type: t, id });
  };
  push(type, args.id);
  push('agent_group', args.agent_group_id ?? args.group);
  push('user', args.user);
  if (out.length === 0) out.push({ type });
  return out;
}

// ── Approval-gated actions ──

/** Dotted audit action per approval type; cli_command derives from its frame. */
export const APPROVAL_AUDIT_ACTIONS: Record<string, string> = {
  install_packages: 'self-mod.install-packages',
  add_mcp_server: 'self-mod.add-mcp-server',
  create_agent: 'agents.create',
  a2a_message_gate: 'messages.a2a-gate',
  onecli_credential: 'onecli.credential.use',
};

export function auditActionForApproval(approvalAction: string, payload: Record<string, unknown>): string {
  if (approvalAction === 'cli_command') {
    const frame = payload.frame as RequestFrame | undefined;
    return (frame && lookup(frame.command)?.action) ?? 'cli.unknown-command';
  }
  return APPROVAL_AUDIT_ACTIONS[approvalAction] ?? approvalAction.replace(/_/g, '.');
}

/**
 * details for an approval's pending/terminal events. Message-bearing payloads
 * (a2a gate) record shape only — body_chars and attachment names, never
 * content; the emit-seam redactor is defense-in-depth, not the mechanism.
 */
export function detailsForApprovalPayload(
  approvalAction: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (approvalAction) {
    case 'cli_command': {
      const frame = payload.frame as RequestFrame | undefined;
      return { ...(frame?.args ?? {}) };
    }
    case 'create_agent': {
      const instructions = typeof payload.instructions === 'string' ? payload.instructions : null;
      return { name: payload.name, instructions_chars: instructions ? instructions.length : 0 };
    }
    case 'a2a_message_gate': {
      const { text, files } = messageShape(payload.content);
      return { to: payload.platform_id, body_chars: text.length, attachments: files };
    }
    default:
      // install_packages, add_mcp_server, and future types: metadata payloads
      // pass through as-is — the emit-seam redactor masks sensitive keys.
      return { ...payload };
  }
}

export function resourcesForApproval(
  approvalAction: string,
  payload: Record<string, unknown>,
  session: Session,
): AuditResource[] {
  const base: AuditResource[] = [{ type: 'agent_group', id: session.agent_group_id }];
  if (approvalAction === 'cli_command') {
    const frame = payload.frame as RequestFrame | undefined;
    const cmd = frame && lookup(frame.command);
    if (cmd && frame) {
      const cliResources = resourcesForCli(cmd, frame.args);
      for (const r of cliResources) {
        if (!base.some((b) => b.type === r.type && b.id === r.id)) base.push(r);
      }
    }
  }
  if (approvalAction === 'a2a_message_gate' && typeof payload.platform_id === 'string' && payload.platform_id) {
    if (payload.platform_id !== session.agent_group_id) {
      base.push({ type: 'agent_group', id: payload.platform_id });
    }
  }
  return base;
}

// ── OneCLI credential approvals ──

/** = APPROVAL_AUDIT_ACTIONS.onecli_credential; named for the OneCLI wrappers. */
export const ONECLI_AUDIT_ACTION = 'onecli.credential.use';

interface OneCliRowShape {
  approval_id: string;
  agent_group_id?: string | null;
  payload: string;
}

interface OneCliPayload {
  oneCliRequestId?: string;
  method?: string;
  host?: string;
  path?: string;
  bodyPreview?: string;
  agent?: { externalId?: string | null; name?: string };
  approver?: string;
}

function oneCliPayload(row: OneCliRowShape): OneCliPayload {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' ? (parsed as OneCliPayload) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- stored payloads are untrusted; a malformed one must not break event assembly
  } catch {
    return {};
  }
}

/** Shape-only: the request body's presence is auditable, its content never is. */
function oneCliDetails(p: OneCliPayload): Record<string, unknown> {
  return {
    method: p.method,
    host: p.host,
    path: p.path,
    one_cli_request_id: p.oneCliRequestId,
    body_preview_chars: typeof p.bodyPreview === 'string' ? p.bodyPreview.length : 0,
  };
}

function oneCliResources(row: OneCliRowShape): AuditResource[] {
  const out: AuditResource[] = [];
  if (row.agent_group_id) out.push({ type: 'agent_group', id: row.agent_group_id });
  out.push({ type: 'approval', id: row.approval_id });
  return out;
}

/** Pending event for a OneCLI credential hold, derived from its row. */
export function oneCliHoldEvent(row: OneCliRowShape): AuditEventInput {
  const p = oneCliPayload(row);
  const resources = oneCliResources(row);
  if (p.approver) resources.push({ type: 'user', id: p.approver });
  return {
    actor: { type: 'agent', id: row.agent_group_id ?? p.agent?.externalId ?? p.agent?.name ?? 'unknown' },
    // OneCLI requests come from inside an agent container but carry no session.
    origin: { transport: 'container' },
    action: ONECLI_AUDIT_ACTION,
    resources,
    outcome: 'pending',
    correlationId: row.approval_id,
    details: oneCliDetails(p),
  };
}

/** approvals.decide for a OneCLI resolution (click, expiry, or startup sweep). */
export function oneCliDecideEvent(
  row: OneCliRowShape & { channel_type?: string | null },
  args: { actor: AuditActor; origin: AuditOrigin; outcome: 'approved' | 'rejected'; reason?: string },
): AuditEventInput {
  const details: Record<string, unknown> = {
    gated_action: ONECLI_AUDIT_ACTION,
    ...oneCliDetails(oneCliPayload(row)),
  };
  if (args.reason) details.reason = args.reason;
  return {
    actor: args.actor,
    origin: args.origin,
    action: 'approvals.decide',
    resources: oneCliResources(row),
    outcome: args.outcome,
    correlationId: row.approval_id,
    details,
  };
}

/** Mirror of agent-route's message-content parse — shape extraction only. */
function messageShape(content: unknown): { text: string; files: string[] } {
  if (typeof content !== 'string') return { text: '', files: [] };
  try {
    const parsed = JSON.parse(content) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content is the raw body; shape extraction must not throw
  } catch {
    return { text: content, files: [] };
  }
}
