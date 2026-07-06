/**
 * Canonical audit event vocabulary — schema_version 1.
 *
 * Fields are chosen to project losslessly onto OCSF and Elastic ECS; the
 * field mapping lives with the design docs and stays documentation until a
 * SIEM forwarder exists.
 */

export type AuditActorType = 'human' | 'agent' | 'system';

export interface AuditActor {
  type: AuditActorType;
  /** `host:<os-user>` | `<channel>:<handle>` | agent group id | `host` (system). */
  id: string;
}

export interface AuditOrigin {
  transport: 'socket' | 'container' | 'channel';
  session_id?: string;
  messaging_group_id?: string;
  channel?: string;
}

export interface AuditResource {
  type: string;
  /** Omitted when only the attempted type is known (e.g. a denied list). */
  id?: string;
}

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'pending' | 'approved' | 'rejected';

/** What emit sites provide. Envelope fields are stamped by emitAuditEvent. */
export interface AuditEventInput {
  actor: AuditActor;
  origin: AuditOrigin;
  /** Dotted namespaced verb, e.g. `groups.config.add-mcp-server`. */
  action: string;
  resources: AuditResource[];
  outcome: AuditOutcome;
  /** The approval id on gated chains; null/omitted otherwise. */
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Stored record — one NDJSON line. The directory-enrichment fields (email,
 * user_id, group_ids) ship in the schema but stamp null until the directory
 * adapter lands; they are filled at write time, never backfilled.
 */
export interface AuditEvent {
  event_id: string;
  time: string;
  schema_version: 1;
  actor: AuditActor & { email: null; user_id: null; group_ids: null };
  origin: AuditOrigin;
  action: string;
  resources: AuditResource[];
  outcome: AuditOutcome;
  correlation_id: string | null;
  details: Record<string, unknown>;
}

/** Actor for timer/sweep-driven outcomes (OneCLI expiry, startup sweeps, ghost rejects). */
export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: 'host' };
