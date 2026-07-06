/**
 * Audit day-file store — the tree's first structured file writer.
 *
 * Daily NDJSON files under data/audit/, named <UTC-day>.ndjson. Append-only is
 * structural: nothing in the system can update a line. Retention is unlinking
 * whole day-files past the horizon — a literal hard delete, no VACUUM. The
 * host process is the single writer by construction (both ncl transports and
 * every approval converge host-side).
 */
import fs from 'fs';
import path from 'path';

import { AUDIT_ENABLED, AUDIT_RETENTION_DAYS, DATA_DIR } from '../config.js';
import { log } from '../log.js';

export const AUDIT_DIR = path.join(DATA_DIR, 'audit');

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC day string (YYYY-MM-DD) — day-file names and prune boundaries. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function dayFilePath(day: string): string {
  return path.join(AUDIT_DIR, `${day}.ndjson`);
}

/**
 * The single append point. Throws on fs failure — emitAuditEvent catches
 * (fail-open + loud lives there, not here).
 */
export function appendAuditLine(line: string): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(dayFilePath(utcDay()), line + '\n');
}

/**
 * Boot-time writability assert — called only when AUDIT_ENABLED. A zero-byte
 * append is a true write probe (fs.access can pass on read-only mounts).
 * Throws so main() refuses to start rather than run with a silent audit gap.
 */
export function assertAuditWritable(): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.appendFileSync(dayFilePath(utcDay()), '');
}

/**
 * Unlink day-files strictly older than (today UTC − retentionDays). 0 or
 * negative = keep forever. Lexicographic compare is correct for ISO days.
 */
export function pruneAuditLog(retentionDays: number = AUDIT_RETENTION_DAYS): void {
  if (retentionDays <= 0) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(AUDIT_DIR);
    // eslint-disable-next-line no-catch-all/no-catch-all -- no audit dir yet means nothing to prune
  } catch {
    return; // Directory absent — nothing recorded yet.
  }
  const horizon = utcDay(new Date(Date.now() - retentionDays * DAY_MS));
  let pruned = 0;
  for (const entry of entries) {
    const m = DAY_FILE_RE.exec(entry);
    if (!m || m[1] >= horizon) continue;
    try {
      fs.unlinkSync(path.join(AUDIT_DIR, entry));
      pruned++;
      // eslint-disable-next-line no-catch-all/no-catch-all -- one stubborn file must not stop the rest of the prune
    } catch (err) {
      log.error('Audit prune failed to unlink day-file', { file: entry, err });
    }
  }
  if (pruned > 0) {
    log.info('Audit retention pruned day-files', { pruned, retentionDays });
  }
}

// Host-sweep throttle: the sweep ticks every 60s but retention only needs to
// move once per UTC day.
let lastPruneDay: string | null = null;

/** Sweep hook — no-op unless audit is enabled with a finite retention. */
export function pruneAuditLogIfDue(): void {
  if (!AUDIT_ENABLED || AUDIT_RETENTION_DAYS <= 0) return;
  const today = utcDay();
  if (lastPruneDay === today) return;
  lastPruneDay = today;
  pruneAuditLog();
}

/** Called after the boot-time prune so the first sweep tick doesn't re-prune. */
export function markPrunedToday(): void {
  lastPruneDay = utcDay();
}
