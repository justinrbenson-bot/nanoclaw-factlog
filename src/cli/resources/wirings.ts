import { randomUUID } from 'crypto';

import { createMessagingGroupAgent } from '../../db/messaging-groups.js';
import type { EngageMode, IgnoredMessagePolicy, MessagingGroupAgent, SenderScope } from '../../types.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'wiring',
  plural: 'wirings',
  table: 'messaging_group_agents',
  description:
    'Wiring — connects a messaging group to an agent group. Determines which agent handles messages from which chat. The same messaging group can be wired to multiple agents; the same agent can be wired to multiple messaging groups.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'The chat/channel to route from. References messaging_groups.id.',
      required: true,
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that handles messages. References agent_groups.id.',
      required: true,
    },
    {
      name: 'engage_mode',
      type: 'string',
      description:
        'When the agent engages. "mention" — only when @mentioned or in DMs. "mention-sticky" — once mentioned in a thread, the agent subscribes and responds to all subsequent messages in that thread without needing further mentions. "pattern" — matches every message against engage_pattern regex.',
      enum: ['pattern', 'mention', 'mention-sticky'],
      default: 'mention',
      updatable: true,
    },
    {
      name: 'engage_pattern',
      type: 'string',
      description:
        'Regex for engage_mode=pattern. Required when mode is pattern. Use "." to match every message (always-on). Ignored for mention modes.',
      updatable: true,
    },
    {
      name: 'sender_scope',
      type: 'string',
      description:
        '"all" — any sender (subject to unknown_sender_policy). "known" — only users with a role or membership in this agent group.',
      enum: ['all', 'known'],
      default: 'all',
      updatable: true,
    },
    {
      name: 'ignored_message_policy',
      type: 'string',
      description:
        'What happens to messages that don\'t trigger engagement. "drop" — agent never sees them. "accumulate" — stored as background context (trigger=0) so the agent has prior context when eventually triggered.',
      enum: ['drop', 'accumulate'],
      default: 'drop',
      updatable: true,
    },
    {
      name: 'session_mode',
      type: 'string',
      description:
        '"shared" — one session per (agent, messaging group). "per-thread" — separate session per thread/topic. "agent-shared" — one session across all messaging groups wired to this agent. Note: threaded adapters in group chats force per-thread regardless of this setting.',
      enum: ['shared', 'per-thread', 'agent-shared'],
      default: 'shared',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` is intentionally not in `operations` — the generic single-table
  // INSERT skips the `agent_destinations` ACL row that the canonical helper
  // `createMessagingGroupAgent` auto-creates, so ncl-wired agents would
  // silently lack the send authorization skill-wired agents get (delivery
  // throws "unauthorized channel destination" for non-origin sends). Provided
  // as a `customOperation` that delegates to the helper instead.
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Wire a messaging group to an agent group. Delegates to createMessagingGroupAgent so the ' +
        'matching agent_destinations ACL row is auto-created (a bare INSERT would skip it, leaving ' +
        'the agent unauthorized to send to the chat). Use --messaging-group-id and --agent-group-id, ' +
        'plus optional --engage-mode, --engage-pattern, --sender-scope, --ignored-message-policy, --session-mode.',
      handler: async (args) => {
        const messagingGroupId = args.messaging_group_id ? String(args.messaging_group_id) : '';
        const agentGroupId = args.agent_group_id ? String(args.agent_group_id) : '';
        if (!messagingGroupId) throw new Error('--messaging-group-id is required');
        if (!agentGroupId) throw new Error('--agent-group-id is required');

        const engageMode = args.engage_mode !== undefined ? String(args.engage_mode) : 'mention';
        if (!['pattern', 'mention', 'mention-sticky'].includes(engageMode)) {
          throw new Error('engage_mode must be one of: pattern, mention, mention-sticky');
        }
        const senderScope = args.sender_scope !== undefined ? String(args.sender_scope) : 'all';
        if (!['all', 'known'].includes(senderScope)) {
          throw new Error('sender_scope must be one of: all, known');
        }
        const ignoredMessagePolicy =
          args.ignored_message_policy !== undefined ? String(args.ignored_message_policy) : 'drop';
        if (!['drop', 'accumulate'].includes(ignoredMessagePolicy)) {
          throw new Error('ignored_message_policy must be one of: drop, accumulate');
        }
        const sessionMode = args.session_mode !== undefined ? String(args.session_mode) : 'shared';
        if (!['shared', 'per-thread', 'agent-shared'].includes(sessionMode)) {
          throw new Error('session_mode must be one of: shared, per-thread, agent-shared');
        }

        const mga: MessagingGroupAgent = {
          id: randomUUID(),
          messaging_group_id: messagingGroupId,
          agent_group_id: agentGroupId,
          engage_mode: engageMode as EngageMode,
          engage_pattern: args.engage_pattern !== undefined ? String(args.engage_pattern) : null,
          sender_scope: senderScope as SenderScope,
          ignored_message_policy: ignoredMessagePolicy as IgnoredMessagePolicy,
          session_mode: sessionMode as MessagingGroupAgent['session_mode'],
          priority: 0,
          created_at: new Date().toISOString(),
        };
        createMessagingGroupAgent(mga);
        return mga;
      },
    },
  },
});
