import type { Migration } from './index.js';

/**
 * The hold-record contract lands on `pending_approvals` (guarded-actions
 * phase 1 — see the guarded-actions decisions doc, decision 5):
 *
 *   - `approver_rule` — who may resolve the hold: 'exclusive' (only
 *     `approver_user_id`, e.g. an a2a policy's named approver) or
 *     'admins-of-scope' (the admin chain of `agent_group_id`, plus the
 *     specific user the card was delivered to when `approver_user_id` is
 *     stamped — the sender/channel "named-or-admin" semantic).
 *   - `approver_scope` — the action's blast radius: 'global' holds (e.g.
 *     `roles grant`) can only be resolved by an owner or global admin; a
 *     scoped admin's click is rejected.
 *   - `dedup_key` — in-flight dedup: while a pending row carries a key, a
 *     second request with the same key is dropped (replaces the sender
 *     table's UNIQUE(messaging_group_id, sender_identity)).
 *
 * Backfills: rows with a named approver were exclusive before this column
 * existed; `agent_group_id` is stamped from the requesting session so
 * click-auth no longer needs the session fallback.
 *
 * `pending_sender_approvals` is dropped: sender admission now holds through
 * the approvals primitive (action 'sender_admit'). In-flight sender cards at
 * upgrade time die with the table — they are transient courtesy cards, and a
 * new message from the same sender re-triggers one.
 */
export const migration019: Migration = {
  version: 19,
  name: 'holds-approver-rule',
  up(db) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN approver_rule TEXT NOT NULL DEFAULT 'admins-of-scope';`);
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN approver_scope TEXT NOT NULL DEFAULT 'group';`);
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN dedup_key TEXT;`);
    db.exec(`UPDATE pending_approvals SET approver_rule = 'exclusive' WHERE approver_user_id IS NOT NULL;`);
    db.exec(
      `UPDATE pending_approvals
         SET agent_group_id = (SELECT s.agent_group_id FROM sessions s WHERE s.id = pending_approvals.session_id)
       WHERE agent_group_id IS NULL AND session_id IS NOT NULL;`,
    );
    db.exec(`DROP INDEX IF EXISTS idx_pending_sender_approvals_mg;`);
    db.exec(`DROP TABLE IF EXISTS pending_sender_approvals;`);
  },
};
