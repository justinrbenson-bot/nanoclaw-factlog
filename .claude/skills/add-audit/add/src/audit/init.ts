/**
 * Boot-time audit wiring — composed in src/index.ts alongside the import of
 * the domain observer (`approvals-observer.audit.ts`, which self-registers).
 *
 * When enabled: assert data/audit/ is writable (refusing to start beats
 * running with a silent audit gap), run the boot prune, and start the
 * registered post-write hooks' lifecycle (init here, maintain via the host
 * sweep, shutdown via the host's graceful-shutdown registry).
 */
import { AUDIT_ENABLED, AUDIT_RETENTION_DAYS } from '../config.js';
import { log } from '../log.js';
import { onShutdown } from '../response-registry.js';
import { initAuditHooks, maintainAuditHooks, shutdownAuditHooks } from './hooks.js';
import { assertAuditWritable, AUDIT_DIR, markPrunedToday, pruneAuditLog, pruneAuditLogIfDue } from './store.js';

export function initAuditLog(): void {
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
  initAuditHooks(); // throw → main() exit 1, same posture as the writability assert
  onShutdown(() => shutdownAuditHooks());
  log.info('Audit log enabled', { dir: AUDIT_DIR, retentionDays: AUDIT_RETENTION_DAYS });
}

/**
 * Host-sweep tick: retention prune (throttled to once per UTC day internally)
 * plus every hook's periodic maintenance. No-op when audit is disabled.
 */
export function maintainAudit(): void {
  pruneAuditLogIfDue();
  if (AUDIT_ENABLED) maintainAuditHooks();
}
