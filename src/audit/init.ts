/**
 * Boot-time audit wiring — one composition line in src/index.ts.
 *
 * The decision observer registers unconditionally (its emits no-op when
 * disabled). When enabled: assert data/audit/ is writable (refusing to start
 * beats running with a silent audit gap) and run the boot prune.
 */
import { AUDIT_ENABLED, AUDIT_RETENTION_DAYS } from '../config.js';
import { log } from '../log.js';
import { registerAuditObserver } from './observer.js';
import { assertAuditWritable, AUDIT_DIR, markPrunedToday, pruneAuditLog } from './store.js';

export function initAuditLog(): void {
  registerAuditObserver();
  if (!AUDIT_ENABLED) return;
  try {
    assertAuditWritable();
  } catch (err) {
    throw new Error(
      `AUDIT_ENABLED=true but the audit directory is not writable: ${AUDIT_DIR} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  pruneAuditLog();
  markPrunedToday();
  log.info('Audit log enabled', { dir: AUDIT_DIR, retentionDays: AUDIT_RETENTION_DAYS });
}
