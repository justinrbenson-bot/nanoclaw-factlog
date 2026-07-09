import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'harness-capabilities',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN harness_capabilities TEXT NOT NULL DEFAULT '{}'").run();

    // Upgrade safety (grandfather). Before this feature every group ran with
    // agent-teams on (the old default settings.json) and Workflow available.
    // Stamp that onto EXISTING rows so an upgrade changes nothing for current
    // groups — this makes the feature non-breaking. Only rows inserted AFTER
    // this migration (new groups, and every group on a fresh install, which
    // has no rows here yet, so this UPDATE is a no-op there) get the lean
    // defaults via the column DEFAULT '{}'. Operators opt existing groups into
    // the lean defaults per group with
    //   ncl groups config update --id <g> --harness-capabilities 'agent-teams=off,workflow=off'
    db.prepare(`UPDATE container_configs SET harness_capabilities = '{"agent-teams":"on","workflow":"on"}'`).run();
  },
};
