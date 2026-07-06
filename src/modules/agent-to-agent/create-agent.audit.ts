/**
 * Agent-creation audit adapter — agents.create for
 * the ungated door. Wraps ONLY the global-scope direct call: the
 * approval-gated path is covered by the pending/decide/terminal chain
 * (runApprovedHandler wraps applyCreateAgent's run) — wrapping the shared
 * body would double-emit.
 */
import { emitAuditEvent } from '../../audit/emit.js';
import type { AuditResource } from '../../audit/types.js';
import { originForSession } from '../../audit/vocab.js';
import type { AgentGroup, Session } from '../../types.js';
// Type-only import from the module this adapter wraps — erased at runtime,
// so create-agent.ts importing this file back is not a cycle.
import type { CreateAgentResult } from './create-agent.js';

type PerformCreateAgentFn = (
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
) => Promise<CreateAgentResult>;

export function auditCreateAgentDirect(inner: PerformCreateAgentFn): PerformCreateAgentFn {
  return async (name, instructions, session, sourceGroup, notify) => {
    const result = await inner(name, instructions, session, sourceGroup, notify);
    emitAuditEvent(() => {
      const resources: AuditResource[] = [{ type: 'agent_group', id: sourceGroup.id }];
      const details: Record<string, unknown> = {
        name,
        parent: sourceGroup.id,
        instructions_chars: instructions ? instructions.length : 0,
      };
      if (result.ok) {
        resources.push({ type: 'agent_group', id: result.agentGroupId });
        details.folder = result.folder;
      } else {
        details.reason = result.reason;
      }
      return {
        actor: { type: 'agent', id: session.agent_group_id },
        origin: originForSession(session),
        action: 'agents.create',
        resources,
        outcome: result.ok ? 'success' : 'failure',
        details,
      };
    });
    return result;
  };
}
