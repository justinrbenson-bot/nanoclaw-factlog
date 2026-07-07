/**
 * Self-mod guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * The structural baseline is today's behavior verbatim: from the container
 * path, self-modification is held unconditionally for the agent group's
 * admin chain. (The equivalent host-side mutations — `ncl groups config
 * add-package` etc. — are separate catalog actions derived from the command
 * registry.)
 */
import { DENY, HOLD, registerGuardedAction, type GuardInput } from '../../guard/index.js';

function selfModBaseline(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(
      { kind: 'admins-of-scope', agentGroupId: input.actor.agentGroupId, deliveredTo: null },
      'group',
      `${label} always requires admin approval from the container path`,
    );
  };
}

registerGuardedAction({
  action: 'self_mod.install_packages',
  approvalAction: 'install_packages',
  baseline: selfModBaseline('install_packages'),
});

registerGuardedAction({
  action: 'self_mod.add_mcp_server',
  approvalAction: 'add_mcp_server',
  baseline: selfModBaseline('add_mcp_server'),
});
