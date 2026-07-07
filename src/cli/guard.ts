/**
 * CLI guard adapter — the command registry's catalog derivation and
 * structural baseline, moved verbatim out of dispatch.ts (guarded-actions
 * phase 2). Declaration is registration: registry.register() derives one
 * catalog entry per command from the CommandDef itself; no second file is
 * edited when a command is added.
 *
 * The baseline carries today's decisions exactly:
 *   host caller → allow (the 0600 socket is the auth story — in code,
 *   unremovable by data);
 *   cli_scope 'disabled' → deny; 'group' → resource allowlist, cross-group
 *   arg denial, cli_scope-change denial;
 *   access 'approval' for agent callers → hold for the group's admin chain,
 *   with the action's blast radius as the approver scope (D1).
 *
 * Arg auto-fill, the sessions-get existence oracle, and post-handler row
 * filtering stay in dispatch.ts — mechanics, not policy.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { ALLOW, DENY, HOLD, type GuardedActionSpec, type GuardInput } from '../guard/index.js';
import type { ApproverScope } from '../types.js';
import type { CommandDef } from './registry.js';

/**
 * Resources reachable under `cli_scope: 'group'` — and, because their rows
 * anchor to one agent group, the resources whose held mutations have
 * group-local blast radius.
 */
export const GROUP_SCOPED_RESOURCES = new Set(['groups', 'sessions', 'destinations', 'members']);

/**
 * Blast radius of a held command, for approver eligibility (D1): a mutation
 * of a non-group-scoped resource (roles, users, wirings, messaging-groups,
 * policies) — or one explicitly targeting another agent group — needs an
 * owner or global admin to approve; a scoped admin's click is rejected.
 */
export function approverScopeFor(
  cmd: Pick<CommandDef, 'resource'>,
  args: Record<string, unknown>,
  callerAgentGroupId: string,
): ApproverScope {
  if (!cmd.resource || !GROUP_SCOPED_RESOURCES.has(cmd.resource)) return 'global';
  const groupRefs = [args.agent_group_id, args.group];
  if (cmd.resource === 'groups' || cmd.resource === 'destinations') groupRefs.push(args.id);
  return groupRefs.some((v) => v !== undefined && v !== callerAgentGroupId) ? 'global' : 'group';
}

/** Dotted catalog action name for a command. */
export function commandGuardAction(cmd: Pick<CommandDef, 'name' | 'action'>): string {
  return cmd.action ?? `cli.${cmd.name}`;
}

/** Catalog entry derived from a CommandDef at registration time. */
export function commandGuardSpec(cmd: CommandDef): GuardedActionSpec {
  return {
    action: commandGuardAction(cmd),
    approvalAction: cmd.access === 'approval' ? 'cli_command' : undefined,
    // Bind a cli_command grant to the exact command it was approved for.
    grantMatches: (grant) => {
      try {
        const payload = JSON.parse(grant.payload) as { frame?: { command?: string } };
        return payload.frame?.command === cmd.name;
      } catch {
        return false;
      }
    },
    baseline: (input) => commandBaseline(cmd, input),
  };
}

function commandBaseline(cmd: CommandDef, input: GuardInput) {
  const { actor } = input;
  if (actor.kind === 'host') return ALLOW('host caller (trusted socket)');
  if (actor.kind !== 'agent') return DENY('CLI commands accept host or agent callers only.');

  const args = input.payload;
  const cliScope = getContainerConfig(actor.agentGroupId)?.cli_scope ?? 'group';

  if (cliScope === 'disabled') {
    return DENY('CLI access is disabled for this agent group.');
  }

  if (cliScope === 'group') {
    // Only allow whitelisted resources and general commands (no resource, like help)
    if (cmd.resource && !GROUP_SCOPED_RESOURCES.has(cmd.resource)) {
      return DENY(`CLI access is scoped to this agent group. Cannot access "${cmd.resource}".`);
    }

    // Enforce group scope on all agent-group-related args.
    // Different resources use different arg names for the agent group ID.
    // Only check --id for resources where it IS the agent group ID.
    for (const key of ['agent_group_id', 'group'] as const) {
      if (args[key] && args[key] !== actor.agentGroupId) {
        return DENY('CLI access is scoped to this agent group.');
      }
    }
    if ((cmd.resource === 'groups' || cmd.resource === 'destinations') && args.id && args.id !== actor.agentGroupId) {
      return DENY('CLI access is scoped to this agent group.');
    }

    // Block cli_scope changes from group-scoped agents (privilege escalation)
    if (args.cli_scope !== undefined || args['cli-scope'] !== undefined) {
      return DENY('Cannot change cli_scope from a group-scoped agent.');
    }
  }

  if (cmd.access === 'approval') {
    return HOLD(
      { kind: 'admins-of-scope', agentGroupId: actor.agentGroupId, deliveredTo: null },
      approverScopeFor(cmd, args, actor.agentGroupId),
      `agent-initiated "${cmd.name}" requires admin approval`,
    );
  }

  return ALLOW('open command');
}
