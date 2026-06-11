---
name: pr-factory
description: Recipe — compose the PR Factory (GitHub PR triage, review, and testing with human approval gates in Slack) from the component skills shipped inside this folder. Apply order, core-version probes, operator setup, and the composed-stack validation.
---

# PR Factory (recipe)

The PR Factory turns incoming GitHub pull requests into Slack threads, each driven by a per-PR worker agent session that triages, reviews, and test-plans the change — with a human approving every consequential action (merges, test runs, skill edits) from an approval card in the thread. An optional supervisor bot takes feedback and improves the worker, and an optional tester bot executes approved test plans on ephemeral VMs. Everything runs inside one NanoClaw host: the webhook receiver, the thread lifecycle, the approval gates, and the VM control plane.

This is a **recipe**: a thin composition layer over the component skills shipped inside this folder. Each component is independently appliable and removable and carries its own SKILL.md, REMOVE.md, `files.txt` manifest, and generated `files/` mirror; the details (apply steps, credentials, guard tests, known smells) live there. Architecture: [docs/pr-factory.md](../../../../docs/pr-factory.md).

**Discovery note:** `recipes/` is not slash-discoverable — there is no `/pr-factory` command. A recipe applies by reading this file: point Claude at `.claude/skills/recipes/pr-factory/SKILL.md` (or run it from a `/setup`-style flow) and follow it top to bottom.

```
.claude/skills/recipes/pr-factory/
  SKILL.md                  # this recipe
  REMOVE.md                 # recipe-level reversal (delegates to the components)
  files.txt + files/        # recipe-owned files: docs + composed-stack tests + sync infra
  skills/
    slack-bots/             # supervisor + tester Slack adapters (named channel instances)
    pr-factory-core/        # the engine: webhook, sessions, approvals, MCP tools, seams
    gh-action-approval/     # approval-gated gh execution (optional)
    vm-test-orchestrator/   # ephemeral test-VM control plane (optional)
    slack-canvas/           # markdown → Slack Canvas rendering (optional)
```

## Prerequisites — the core train

The components make near-zero core edits because core already ships the hooks they register against. Probe each; on a failed probe, **stop** and land the named PR (or update to a version of core that contains it) first.

| Probe | Lands with |
|---|---|
| `test -f src/db/migrations/016-messaging-group-instance.ts && grep -q 'instance?: string' src/channels/adapter.ts && echo OK` | PR #2733 — native channel-instance substrate |
| `grep -q 'export function getDeliveryAction' src/delivery.ts && echo OK` | PR #2734 — delivery-action read-side getter |
| `grep -q 'byLine' src/channels/chat-sdk-bridge.ts && echo OK` | PR #2735 — approval-card actor byline |
| `grep -q 'justWoke' src/host-sweep.ts && echo OK` | PR #2736 — host-sweep wake grace period |
| `grep -q 'export function registerApprovalResolvedHandler' src/modules/approvals/primitive.ts && echo OK` | PR #2737 — approval-resolved hook |
| `awk '/export function writeOutboundDirect/,/^}/' src/session-manager.ts \| grep -q openOutboundDbRw && echo OK` | PR #2738 — writeOutboundDirect read-write fix |
| `grep -q 'export function registerWebhookHandler' src/webhook-server.ts && echo OK` | PR #2739 — raw webhook-route registry |

The component SKILL.mds re-probe the subset each one depends on; this table is the full train.

## Apply order

Order is load-bearing: `slack-bots` patches the adapter `/add-slack` installs, `pr-factory-core` imports `slack-bots`' instance constants, and the three optional components register on seams owned by `pr-factory-core`. Apply each component by following its own SKILL.md.

1. **`/add-slack`** (stock channel skill) — the worker bot. **Pin `@chat-adapter/slack@4.26.0`**, not the 4.27.0 in that skill's text: 4.27.0 pulls `chat@4.27.0` types that fail the build against core's `chat@^4.24.0` resolution. Replace that skill's install command with `pnpm install @chat-adapter/slack@4.26.0 --save-exact` — the exact pin matters; a caret range re-resolves to 4.27.0 and breaks the build later.
2. **`skills/slack-bots`** — supervisor + tester Slack apps as named channel instances, sibling-echo suppression, the bot_id→instance fork-upgrade migration.
3. **`skills/pr-factory-core`** — the engine. Inert until `GITHUB_WEBHOOK_SECRET` is set.
4. **`skills/gh-action-approval`** *(optional)* — without it, `credentialed_gh` calls answer "component not installed".
5. **`skills/vm-test-orchestrator`** *(optional)* — without it, approved test plans answer "no test orchestrator installed".
6. **`skills/slack-canvas`** *(optional)* — without it, plans and reviews post as plain text + `.md` uploads.

Finally copy in the recipe-owned files (idempotent, like every apply step; run from the repo root, like every command in this bundle):

```bash
RECIPE=.claude/skills/recipes/pr-factory
cp $RECIPE/files/docs/pr-factory.md docs/pr-factory.md
cp $RECIPE/files/src/recipe-pr-factory-stack.test.ts src/recipe-pr-factory-stack.test.ts
cp $RECIPE/files/scripts/sync-skill-files.sh scripts/sync-skill-files.sh && chmod +x scripts/sync-skill-files.sh
cp $RECIPE/files/src/skill-sync.test.ts src/skill-sync.test.ts
```

`sync-skill-files.sh` + `skill-sync.test.ts` are the manifest/mirror infrastructure every component's `files/` folder is generated by; the stack test is described under Validate.

## Operator setup

Summary only — each item is detailed in the named component's SKILL.md:

- **Three Slack apps** in one workspace: worker (`/add-slack`), supervisor + tester (`skills/slack-bots` → Credentials). Webhook URLs `/webhook/slack`, `/webhook/slack-supervisor`, `/webhook/slack-tester`.
- **GitHub webhook**: set `GITHUB_WEBHOOK_SECRET` in `.env` and add a Pull requests webhook on the repo pointing at `/webhook/github` (`skills/pr-factory-core` → Configuration).
- **Channels + repo env**: `PR_FACTORY_SLACK_CHANNEL_ID`, optional `PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID`, `PR_FACTORY_DEFAULT_REPO` (`skills/pr-factory-core`).
- **Approver roles (required)**: core silently ignores approval-card clicks from users without a `user_roles` row. `pnpm run ncl roles grant --user 'slack:U0XXXXXXX' --role admin` for every human who will click cards (`skills/pr-factory-core` → "Grant approver roles").
- **gh auth + approver mapping**: install `gh`, log in each approver's account, create `data/gh-users.json` from the shipped sample — keys are **namespaced** (`"slack:U0XXX": "gh-login"`) with no bare-id fallback (`skills/gh-action-approval`).
- **VM pool knobs**: `PR_FACTORY_TEST_VM_TEMPLATE` (required for test runs), `PR_FACTORY_TEST_SSH_HOST`, `TEST_VM_SSH_USER`, `TEST_VM_NAME_PREFIX`, `TEST_VM_HOST_TEMPLATE` — defaults are exe.dev's conventions; any SSH-driven provider works (`skills/vm-test-orchestrator`). Tester needs the operator-created `pr-tester` agent group.

## Validate

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
```

All suites green. `src/recipe-pr-factory-stack.test.ts` is the composed-stack leg: it runs the full migration chain (instance substrate + the two component migrations) on a fresh DB, bootstraps the PR Factory entities on that composed schema, asserts the delivery file-transform slot has exactly one registrant across all modules, and runs `sync-skill-files.sh --all --check` so a drifted component mirror fails CI. Each component's own guard tests cover its integration points.

## What you get

- **Per-PR worker flow** — webhook → Slack thread (status reactions 🟢⚪🔴🟣) → per-thread agent session seeded with the diff → triage report → review → test plan. The default triage/review/test-plan workflow is seeded into `groups/pr-factory-worker/CLAUDE.local.md` (edit it to tune trusted contributors, merge policy, review depth) or replaced wholesale via `PR_FACTORY_REVIEW_SKILL`.
- **Approval cards for every consequential action** — send-to-testing, retry, skill edits, and every `gh` write (merge, close, comment), executed with the approving human's gh identity.
- **Supervisor bot** — its own Slack identity; takes feedback in an admin channel or @-mentioned in PR threads, proposes worker skill/instruction edits behind a diff + approval card, clears and retriggers PR sessions.
- **VM test runs** — approved plans clone an ephemeral VM from a template, check out the PR, build, boot, and hand the VM to the tester agent; PASS wakes the worker to propose a merge, FAIL to analyze.
- **Canvases** — test plans, results, and review writeups render as Slack Canvases instead of file uploads (paid Slack plan; falls back to `.md` uploads otherwise).

## Upgrading a pre-instance fork install

For installs that ran the PR Factory on the old `bot_id` multi-bot substrate. Boot order matters — **never boot bare core on such a DB** (migration 016 crash-loops on the supervisor/tester rows):

1. Stop the host.
2. Check out a tree with this recipe **fully applied** (all components).
3. Boot. The two component migrations run first: `module-slack-bots-bot-id-to-instance` maps `bot_id` rows to instances and rewrites the Chat SDK state namespaces; `module-pr-factory-pr-threads-v2` drops the dead `bot_id` column from `pr_threads`.
4. Verify the Slack webhook URLs — they are byte-identical (`/webhook/slack-supervisor`, `/webhook/slack-tester`), so the Slack app consoles need zero changes.
5. Expect at most one re-@mention per subscribed thread (`chat_sdk_locks` is cleared; it is TTL-bound state).
6. **Re-key `data/gh-users.json` to namespaced ids** (`"U0XXX"` → `"slack:U0XXX"`). An un-migrated mapping silently degrades every approver to the default gh credentials — there is no bare-id fallback.
7. Operator data carries by hand: `data/gh-users.json`, the repo mirror dir, `groups/pr-tester/`, the OneCLI vault.

## Remove

[REMOVE.md](REMOVE.md) — runs the component REMOVE.mds in reverse apply order, then deletes the recipe-owned files.
