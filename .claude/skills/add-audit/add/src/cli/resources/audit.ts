/**
 * `ncl audit` — read-only query surface over the local audit log
 * (append-only NDJSON day-files under data/audit/, see src/audit/).
 *
 * Scope: host callers and global-scope agents only. `audit` is deliberately
 * NOT on the dispatcher's group-scope allowlist, so group-scoped agents are
 * refused before any handler runs (fails closed) — the log spans groups.
 * Requires AUDIT_ENABLED=true; a disabled box errors rather than returning an
 * empty list that would read as "no actions happened".
 */
import { listAuditEvents } from '../../audit/reader.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'audit_event',
  plural: 'audit',
  // File-backed, not a table — safe because no generic operations are
  // declared, so nothing ever queries this name.
  table: '(data/audit/*.ndjson)',
  description: 'Local audit log — one event per ncl command and host-routed approval. Newest first.',
  idColumn: 'event_id',
  columns: [
    {
      name: 'actor',
      type: 'string',
      description: 'Filter: exact actor id (host:<user>, <channel>:<handle>, agent group id)',
    },
    { name: 'action', type: 'string', description: 'Filter: exact action or dotted prefix (e.g. groups.config)' },
    { name: 'resource', type: 'string', description: 'Filter: matches any event resource by id or type' },
    {
      name: 'outcome',
      type: 'string',
      description: 'Filter: event outcome',
      enum: ['success', 'failure', 'denied', 'pending', 'approved', 'rejected'],
    },
    { name: 'since', type: 'string', description: 'Window start: 7d / 24h / 30m relative, or ISO date' },
    { name: 'until', type: 'string', description: 'Window end: same formats as --since' },
    { name: 'correlation', type: 'string', description: 'Filter: approval id tying a gated chain together' },
    { name: 'limit', type: 'number', description: 'Max events (default 100, newest first)' },
    { name: 'format', type: 'string', description: 'Output format', enum: ['ndjson'] },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'Query audit events, newest first. --format ndjson streams the stored lines for SIEM export.',
      handler: async (args) => listAuditEvents(args),
    },
  },
});
