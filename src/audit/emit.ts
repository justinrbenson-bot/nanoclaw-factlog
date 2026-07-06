/**
 * emitAuditEvent — the single opt-in check and the single append point.
 *
 * Only src/audit/ may call this (wrappers compose it at module edges;
 * business logic never does): `grep emitAuditEvent src/` outside this
 * directory must stay empty.
 */
import { randomUUID } from 'crypto';

import { AUDIT_ENABLED } from '../config.js';
import { log } from '../log.js';
import { redactDetails } from './redact.js';
import { appendAuditLine } from './store.js';
import type { AuditEvent, AuditEventInput } from './types.js';

export function emitAuditEvent(input: AuditEventInput | (() => AuditEventInput)): void {
  if (!AUDIT_ENABLED) return; // The one opt-in check — the whole feature switches here.
  try {
    // Lazy inputs keep a disabled box at literally zero audit work (and shield
    // the action from assembly errors — origin lookups can touch the DB).
    if (typeof input === 'function') input = input();
    const event: AuditEvent = {
      event_id: randomUUID(),
      time: new Date().toISOString(),
      schema_version: 1,
      // Directory-enrichment fields stamp null until the adapter lands.
      actor: { ...input.actor, email: null, user_id: null, group_ids: null },
      origin: input.origin,
      action: input.action,
      resources: input.resources,
      outcome: input.outcome,
      correlation_id: input.correlationId ?? null,
      details: redactDetails(input.details ?? {}),
    };
    appendAuditLine(JSON.stringify(event));
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-open is the contract: auditing must never take down the audited action
  } catch (err) {
    // Fail-open + loud: the audited action must proceed even when the log
    // can't be written (a full disk must not brick recovery commands).
    const action = typeof input === 'function' ? undefined : input.action;
    log.error('Audit append failed — action proceeding (fail-open)', { action, err });
  }
}
