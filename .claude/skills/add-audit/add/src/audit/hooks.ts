/**
 * Post-write audit hooks — the in-process extension seam.
 *
 * A hook observes the audit LOG, not the event stream: `onEvent` fires only
 * after an event has been durably appended to the local day-file, so anything
 * a hook exports is guaranteed to exist in the source of truth
 * (exported ⊆ written). If the local append fails, hooks are not called —
 * and a hook that misses events (crash, restart) catches up by reading the
 * day-files, which is the at-least-once story.
 *
 * Registration follows the tree's observer idiom (registerApprovalResolvedHandler,
 * registerResponseHandler, …): an in-tree or skill-installed module calls
 * `registerAuditHook(...)` at import time — no core edits, and credentials or
 * transport for an external system live in that module, never here.
 */
import { log } from '../log.js';
import type { AuditEvent } from './types.js';

export interface AuditHook {
  /** Short identifier used in logs and lifecycle errors. */
  name: string;
  /**
   * Called after a successful local append. `line` is the exact stored bytes
   * (one NDJSON line, no trailing newline); `event` is the parsed record.
   * MUST be fast and non-blocking — this runs on the audited action's call
   * path. A real exporter buffers here and does its IO from `maintain`/its own
   * timers. Throwing is tolerated: isolated and logged, never propagated.
   */
  onEvent(event: AuditEvent, line: string): void;
  /** Boot hook, called only when audit is enabled. Throw = host refuses to start. */
  init?(): void;
  /** Periodic maintenance — called from the 60s host-sweep (enabled boxes only). */
  maintain?(): void;
  /** Graceful-shutdown hook (flush buffers, close handles). */
  shutdown?(): void | Promise<void>;
}

const hooks: AuditHook[] = [];

export function registerAuditHook(hook: AuditHook): void {
  hooks.push(hook);
}

/** Fan out one written event to every hook, isolating failures per hook. */
export function notifyAuditHooks(event: AuditEvent, line: string): void {
  for (const hook of hooks) {
    try {
      hook.onEvent(event, line);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad hook must not affect the log, other hooks, or the audited action
    } catch (err) {
      log.error('Audit hook threw — event is safely in the log', { hook: hook.name, action: event.action, err });
    }
  }
}

/** Boot lifecycle. A hook that can't start is a silent-export-gap risk — fatal. */
export function initAuditHooks(): void {
  for (const hook of hooks) {
    try {
      hook.init?.();
    } catch (err) {
      throw new Error(
        `audit hook "${hook.name}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/** Sweep lifecycle — periodic maintenance, isolated per hook. */
export function maintainAuditHooks(): void {
  for (const hook of hooks) {
    try {
      hook.maintain?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- one hook's maintenance failure must not stop the others (or the sweep)
    } catch (err) {
      log.error('Audit hook maintenance failed', { hook: hook.name, err });
    }
  }
}

/** Shutdown lifecycle — awaited by the host's graceful shutdown. */
export async function shutdownAuditHooks(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.shutdown?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- shutdown must drain every hook even when one throws
    } catch (err) {
      log.error('Audit hook shutdown failed', { hook: hook.name, err });
    }
  }
}
