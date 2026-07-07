/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Every command passes the guard before its handler runs — the decision
 * (allow / hold / deny) comes from the command's catalog entry, derived at
 * registration (see cli/guard.ts). Dispatch keeps the mechanics: arg
 * auto-fill, the sessions-get existence oracle, parseArgs, and post-handler
 * row filtering. An approved replay re-enters here carrying the verified
 * approval row as its grant — the guard re-checks the structural baseline
 * live, and the `approved: true` boolean no longer exists.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { guard, type GuardActor } from '../guard/index.js';
import { log } from '../log.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import type { PendingApproval } from '../types.js';
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { getResource } from './crud.js';
import { commandGuardAction } from './guard.js';
import { lookup } from './registry.js';

type DispatchOptions = {
  /** Verified approval row when a command is replayed after approval. */
  grant?: PendingApproval;
};

function actorFor(ctx: CallerContext): GuardActor {
  return ctx.caller === 'host'
    ? { kind: 'host' }
    : { kind: 'agent', agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId };
}

export async function dispatch(
  req: RequestFrame,
  ctx: CallerContext,
  opts: DispatchOptions = {},
): Promise<ResponseFrame> {
  let cmd = lookup(req.command);

  // Fallback: if the full command isn't registered, split the dash-joined
  // command and treat the longest registered prefix as the command, with the
  // re-joined remainder as the target ID. Clients join all positional args
  // with dashes (e.g. `ncl groups get abc123` → command "groups-get-abc123"),
  // and generated ids (UUIDs, `sess-…`, `appr-…`) themselves contain dashes,
  // so trimming a single trailing segment isn't enough — walk prefixes from
  // longest to shortest so `groups-get-<uuid-with-dashes>` still resolves to
  // "groups-get" + id "<uuid-with-dashes>".
  if (!cmd) {
    const parts = req.command.split('-');
    for (let i = parts.length - 1; i > 0; i--) {
      const shortened = parts.slice(0, i).join('-');
      const fallback = lookup(shortened);
      if (fallback) {
        const tail = parts.slice(i).join('-');
        cmd = fallback;
        req = { ...req, command: shortened, args: { ...req.args, id: req.args.id ?? tail } };
        break;
      }
    }
  }

  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  // Group-scope mechanics for agent callers (visibility, not policy — the
  // decisions live in the guard baseline, cli/guard.ts).
  if (ctx.caller === 'agent') {
    const configRow = getContainerConfig(ctx.agentGroupId);
    const cliScope = configRow?.cli_scope ?? 'group';

    if (cliScope === 'group') {
      // Auto-fill agent-group-related args so the agent doesn't need
      // to pass its own group ID explicitly.
      const fill: Record<string, unknown> = {
        agent_group_id: req.args.agent_group_id ?? ctx.agentGroupId,
        group: req.args.group ?? ctx.agentGroupId,
      };
      // Only auto-fill --id for resources where it IS the agent group ID
      // (groups, destinations). For sessions/members --id is a different key.
      if (cmd.resource === 'groups' || cmd.resource === 'destinations') {
        fill.id = req.args.id ?? ctx.agentGroupId;
      }
      req = { ...req, args: { ...req.args, ...fill } };

      // Fail-closed pre-handler check for sessions-get: returns "not found"
      // regardless of whether the UUID exists in another group, preventing an
      // existence oracle across group boundaries.
      if (cmd.resource === 'sessions' && req.command === 'sessions-get' && req.args.id) {
        const s = getSession(req.args.id as string);
        if (!s || s.agent_group_id !== ctx.agentGroupId) {
          return err(req.id, 'handler-error', `session not found: ${req.args.id}`);
        }
      }
    }
  }

  const decision = guard({
    action: commandGuardAction(cmd),
    actor: actorFor(ctx),
    payload: req.args,
    grant: opts.grant ?? null,
  });

  if (decision.effect === 'deny') {
    return err(req.id, 'forbidden', decision.reason);
  }

  if (decision.effect === 'hold') {
    if (ctx.caller !== 'agent') {
      // Holds only arise for agent callers; anything else is a guard bug —
      // fail closed rather than card a ghost.
      return err(req.id, 'forbidden', decision.reason);
    }
    const session = getSession(ctx.sessionId);
    if (!session) {
      return err(req.id, 'handler-error', 'Session not found.');
    }
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const agentName = agentGroup?.name ?? ctx.agentGroupId;

    const argSummary = Object.entries(req.args)
      .map(([k, v]) => `--${k} ${v}`)
      .join(' ');

    await requestApproval({
      session,
      agentName,
      action: 'cli_command',
      payload: { frame: { id: req.id, command: req.command, args: req.args }, callerContext: ctx },
      title: `CLI: ${req.command}`,
      question: `Agent "${agentName}" wants to run:\n\`ncl ${req.command}${argSummary ? ' ' + argSummary : ''}\``,
      approverScope: decision.approverScope,
    });

    return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
  }

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    let data = await cmd.handler(parsed, ctx);

    // Post-handler group-scope enforcement. Applies only to the auto-generated
    // `list` / `get` handlers (`cmd.generic`), which return raw DB rows carrying
    // the resource's `scopeField`:
    //   - `list` → drop rows that don't belong to the caller's agent group
    //              (covers `groups list`, where the generic list handler ignores
    //              the auto-filled `--id`)
    //   - `get`  → reject if the single row belongs to another group
    // Custom operations return ad-hoc shapes (e.g. `groups config get` → a config
    // object with no `id`) and are NOT checked here — they would be falsely
    // rejected, and they're already pinned to the caller's group by the
    // pre-handler `--id` auto-fill (groups/destinations) or gated behind approval,
    // so they can't reach another group's data anyway.
    if (ctx.caller === 'agent' && cmd.resource && cmd.generic) {
      const configRow = getContainerConfig(ctx.agentGroupId);
      if ((configRow?.cli_scope ?? 'group') === 'group') {
        const def = getResource(cmd.resource);
        const groupField = def?.scopeField;
        if (!groupField) {
          // Fail closed: a whitelisted resource exposing list/get must declare
          // `scopeField` so its rows can be filtered.
          return err(req.id, 'forbidden', `"${cmd.resource}" is not available in group scope.`);
        }
        if (Array.isArray(data)) {
          data = data.filter(
            (row) =>
              typeof row === 'object' &&
              row !== null &&
              (row as Record<string, unknown>)[groupField] === ctx.agentGroupId,
          );
        } else if (data && typeof data === 'object') {
          if ((data as Record<string, unknown>)[groupField] !== ctx.agentGroupId) {
            return err(req.id, 'forbidden', 'Resource belongs to a different agent group.');
          }
        }
      }
    }

    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

registerApprovalHandler('cli_command', async ({ payload, approval, notify }) => {
  const frame = payload.frame as RequestFrame;
  const callerContext = parseCallerContext(payload.callerContext);
  if (!callerContext) {
    // D2: a malformed caller context must refuse the replay — never fall
    // back to the most privileged caller.
    log.warn('cli_command replay refused — malformed caller context', { command: frame?.command });
    notify(
      `Your \`ncl ${frame?.command ?? '?'}\` request was approved, but its caller context could not be verified — the replay was refused.`,
    );
    return;
  }
  const response = await dispatch(frame, callerContext, { grant: approval });

  if (response.ok) {
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    notify(`Your \`ncl ${frame.command}\` request was approved and executed.\n\n${data}`);
  } else {
    notify(`Your \`ncl ${frame.command}\` request was approved but failed: ${response.error.message}`);
  }
});

function parseCallerContext(value: unknown): CallerContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.caller === 'host') return { caller: 'host' };
  if (
    record.caller === 'agent' &&
    typeof record.sessionId === 'string' &&
    typeof record.agentGroupId === 'string' &&
    typeof record.messagingGroupId === 'string'
  ) {
    return {
      caller: 'agent',
      sessionId: record.sessionId,
      agentGroupId: record.agentGroupId,
      messagingGroupId: record.messagingGroupId,
    };
  }
  return undefined;
}

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
