import { listAuditEvents } from '../../audit/reader.js';
import { registerResource } from '../crud.js';

/**
 * Read-only audit resource (installed by /add-audit). The "table" is the
 * NDJSON day-file store — no generic CRUD verbs are declared, so it is never
 * queried as SQL; `list` is a custom operation backed by the audit reader.
 *
 * Deliberately NOT on the group-scope allowlist (GROUP_SCOPE_RESOURCES):
 * audit spans agent groups, so group-scoped agents are refused before the
 * handler — the resource is host + `cli_scope: global` only, by omission
 * (fails closed).
 */
registerResource({
  name: 'audit_event',
  plural: 'audit',
  table: '(data/audit/*.ndjson)',
  description: 'Local audit log — one event per ncl command. Newest first. Requires AUDIT_ENABLED=true.',
  idColumn: 'event_id',
  columns: [
    { name: 'actor', type: 'string', description: 'Filter: exact actor id (host:<user>, <channel>:<handle>, agent group id)' },
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
      examples: [
        'ncl audit list --outcome denied --since 7d',
        'ncl audit list --correlation appr-1751970000000-x1y2z3',
        'ncl audit list --action groups.config --format ndjson',
      ],
      handler: async (args) => listAuditEvents(args),
      formatHuman: (data) => {
        // NDJSON export prints the stored lines verbatim; for the table view
        // this throws so dispatch falls back to the row objects, which every
        // client already renders.
        if (typeof data === 'string') return data;
        throw new Error('render rows client-side');
      },
    },
  },
});
