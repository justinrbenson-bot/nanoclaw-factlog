/**
 * Agent-to-agent guard adapter — the module's catalog entries and the
 * guard's first rule source, composed at the module edge (imported by
 * ./index.ts).
 *
 * agents.create — the cli_scope branch moved verbatim out of
 * create-agent.ts: `global` scope creates directly (create_agent is the
 * intended primitive for trusted owner agent groups); anything else — the
 * default `group` scope, and unknown/missing config, fail-closed — holds for
 * the requesting group's admin chain.
 *
 * a2a.send — the structural baseline moved verbatim out of
 * routeAgentMessage: self-sends allow without a destination row; a missing
 * destination row denies; a missing target group denies. The
 * agent_message_policies table becomes a RULE SOURCE: a row for the
 * (from, to) pair holds exclusively for the row's named approver. The
 * ghost-policy edge (policy row with no destination row) composes to DENY —
 * deny > hold in the lattice, exactly today's outcome (the destination
 * throw preceded the policy check).
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, registerGuardedAction, registerRuleSource } from '../../guard/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { getMessagePolicy } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

registerGuardedAction({
  action: 'agents.create',
  approvalAction: 'create_agent',
  // Bind a create_agent grant to the name that was approved.
  grantMatches: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  baseline: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_agent is a container-originated action.');
    const cliScope = getContainerConfig(input.actor.agentGroupId)?.cli_scope ?? 'group';
    if (cliScope === 'global') {
      // Trusted owner agent group — an approval tap on every sub-agent spawn
      // would be needless friction.
      return ALLOW('trusted global-scope agent group');
    }
    // The realistic prompt-injection victim (default `group` scope) — and any
    // unknown config value, fail-closed — requires an admin before any
    // central-DB write.
    return HOLD(
      { kind: 'admins-of-scope', agentGroupId: input.actor.agentGroupId, deliveredTo: null },
      'group',
      'agent-initiated create_agent requires admin approval',
    );
  },
});

registerGuardedAction({
  action: 'a2a.send',
  approvalAction: A2A_MESSAGE_GATE_ACTION,
  // Bind an a2a grant to the exact held message target.
  grantMatches: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { platform_id?: string }).platform_id === input.resource?.to;
    } catch {
      return false;
    }
  },
  baseline: (input) => {
    if (input.actor.kind !== 'agent') return DENY('agent-to-agent send requires an agent actor');
    const from = input.actor.agentGroupId;
    const to = input.resource?.to ?? '';
    const isSelf = to === from;
    if (!isSelf && !hasDestination(from, 'agent', to)) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (!getAgentGroup(to)) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    return ALLOW(isSelf ? 'self-send' : 'destination grant exists');
  },
});

// The guard's first rule source: agent_message_policies rows are tighten-only
// holds with a named (exclusive) approver. Self-sends are never gated.
registerRuleSource((input) => {
  if (input.action !== 'a2a.send' || input.actor.kind !== 'agent') return [];
  const to = input.resource?.to;
  if (!to || to === input.actor.agentGroupId) return [];
  const policy = getMessagePolicy(input.actor.agentGroupId, to);
  if (!policy) return [];
  return [
    {
      effect: 'hold',
      eligibility: { kind: 'exclusive', approverUserId: policy.approver },
      reason: `a2a message policy ${input.actor.agentGroupId}→${to} holds for ${policy.approver}`,
    },
  ];
});
