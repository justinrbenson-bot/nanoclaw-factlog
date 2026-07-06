---
name: add-audit
description: Add an opt-in local audit log — every ncl command (both transports, including denials), every host-routed approval (pending/decision/terminal, correlated by approval id), permissions card decisions, OneCLI credential holds, and ungated agent creation, written as SIEM-shaped append-only NDJSON day-files under data/audit/. Read back with `ncl audit list`; export exporters via registerAuditHook. Off until AUDIT_ENABLED=true.
---

# /add-audit — opt-in local audit log

Records one canonical, SIEM-shaped event per action — actor, origin, dotted
action, touched resources, outcome, approval correlation — to append-only
NDJSON day-files under `data/audit/`. Feature is **opt-in**: with
`AUDIT_ENABLED` unset nothing is persisted, the emit seam no-ops at one
boolean check, and `data/audit/` is never created.

Architecture: `src/audit/` is a **domain-free leaf** (schema, emit seam,
store, reader, post-write hooks, shared vocabulary). How each domain
describes itself lives in **domain-owned `*.audit.ts` adapter files** next to
the code they observe; each composes at its module's edge in one line.
Business logic contains zero audit calls: `grep emitAuditEvent src/` matches
only `src/audit/` and `*.audit.ts`.

The adapters compose on seams trunk already ships (`DispatchTrace`,
`ApprovalHold`, `SenderApprovalResult`/`ChannelApprovalResult`,
`CreateAgentResult`, the `userId` arg on `resolveOneCLIApproval`). If an edit
below is already present, skip it — apply is safe to re-run.

## Steps

### 1. Copy the files

```bash
cp -R .claude/skills/add-audit/add/src/. src/
```

Adds `src/audit/` (the leaf + its tests), the domain adapters
(`src/cli/dispatch.audit.ts`, `src/modules/approvals/approvals.audit.ts`,
`src/modules/approvals/approvals-observer.audit.ts`,
`src/modules/permissions/permissions.audit.ts`,
`src/modules/agent-to-agent/create-agent.audit.ts`), their tests, the
`ncl audit` resource (`src/cli/resources/audit.ts`), and
`src/audit-wiring.test.ts`. No dependency is added — the module is stdlib-only.

### 2. Register the `ncl audit` resource

Append to `src/cli/resources/index.ts`:

```ts
import './audit.js';
```

### 3. Add the two config vars to `src/config.ts`

Add both names to the `readEnvFile([...])` array:

```ts
  'AUDIT_ENABLED',
  'AUDIT_RETENTION_DAYS',
```

Then append after the `ONECLI_GATEWAY_CONTAINER` export block:

```ts
// Local audit log — opt-in (installed by /add-audit). Off by default: the
// audit emitter no-ops and data/audit/ is never created.
export const AUDIT_ENABLED = (process.env.AUDIT_ENABLED || envConfig.AUDIT_ENABLED) === 'true';
// Audit day-files older than this many days are unlinked (a hard delete).
// 0 = keep forever. Read only when AUDIT_ENABLED=true.
const auditRetentionRaw = parseInt(process.env.AUDIT_RETENTION_DAYS || envConfig.AUDIT_RETENTION_DAYS || '90', 10);
export const AUDIT_RETENTION_DAYS = Number.isNaN(auditRetentionRaw) ? 90 : auditRetentionRaw;
```

### 4. Compose the dispatch middleware — `src/cli/dispatch.ts`

Add to the import block:

```ts
import { withAudit } from './dispatch.audit.js';
```

Rename the dispatcher (signature line only):

```ts
export async function dispatch(   →   async function dispatchInner(
```

Insert immediately after `dispatchInner`'s closing brace (before the
`registerApprovalHandler('cli_command', ...)` call):

```ts
/**
 * Public dispatcher — the audit middleware wraps the inner dispatcher, so the
 * socket server, the container delivery-action, and the approved replay are
 * all covered without changing a call site.
 */
export const dispatch = withAudit(dispatchInner);
```

### 5. Decorate requestApproval — `src/modules/approvals/primitive.ts`

Add to the import block:

```ts
// Sibling adapter import; it imports this module back type-only (no cycle).
import { auditRequestApproval } from './approvals.audit.js';
```

Rename the request function (signature line only):

```ts
export async function requestApproval(   →   async function requestApprovalInner(
```

Insert immediately after `requestApprovalInner`'s closing brace:

```ts
/**
 * Public export — the audit decorator wraps the inner request so every gated
 * hold emits its pending event from one place. Pass-through: callers see the
 * hold exactly as the inner returns it.
 */
export const requestApproval = auditRequestApproval(requestApprovalInner);
```

### 6. Wrap the approved-handler run — `src/modules/approvals/response-handler.ts`

Add to the import block:

```ts
import { runApprovedHandler } from './approvals.audit.js';
```

Replace the handler invocation inside `handleRegisteredApproval`:

```ts
await handler({ session, payload, userId, approvalId: approval.approval_id, notify });
```

with:

```ts
// runApprovedHandler wraps the invocation to emit the gated chain's
// terminal audit event; rethrows, so the catch below behaves as before.
await runApprovedHandler(
  handler,
  { session, payload, userId, approvalId: approval.approval_id, notify },
  approval,
  session,
);
```

### 7. Wrap the OneCLI paths — `src/modules/approvals/onecli-approvals.ts`

Add to the import block:

```ts
import { auditOneCliDecision, auditOneCliExpiry, auditOneCliHold, auditOneCliSweep } from './approvals.audit.js';
```

Four compositions:

a. After the `shortApprovalId()` function, add:

```ts
/** Row insert for a hold — the audit wrapper emits the pending event from it. */
const recordOneCliHold = auditOneCliHold(createPendingApproval);
```

and inside `handleRequest`, change the row insert `createPendingApproval({`
to `recordOneCliHold({`.

b. Rename `export function resolveOneCLIApproval(` to
`function resolveOneCLIApprovalInner(` (signature line only) and insert after
its closing brace:

```ts
/**
 * The audit wrapper records the decision with the clicking admin as actor
 * (OneCLI rows never reach notifyApprovalResolved, so the shared observer
 * can't cover them).
 */
export const resolveOneCLIApproval = auditOneCliDecision(resolveOneCLIApprovalInner);
```

c. Rename `async function expireApproval(` to
`async function expireApprovalInner(` and insert after its closing brace:

```ts
/** Timer-driven expiry — the audit wrapper records a system-actor rejection. */
const expireApproval = auditOneCliExpiry(expireApprovalInner);
```

d. Rename `async function sweepStaleApprovals(` to
`async function sweepStaleApprovalsInner(` and insert after its closing brace:

```ts
/** Startup sweep — the audit wrapper records a system-actor rejection per row. */
const sweepStaleApprovals = auditOneCliSweep(sweepStaleApprovalsInner, () =>
  getPendingApprovalsByAction(ONECLI_ACTION),
);
```

### 8. Wrap the permissions decisions — `src/modules/permissions/index.ts`

Add to the import block:

```ts
import { auditChannelDecision, auditChannelNameInterceptor, auditSenderDecision } from './permissions.audit.js';
```

Replace the three registration coercions:

```ts
registerResponseHandler(async (payload) => (await handleSenderApprovalResponse(payload)).claimed);
→ registerResponseHandler(auditSenderDecision(handleSenderApprovalResponse));

registerResponseHandler(async (payload) => (await handleChannelApprovalResponse(payload)).claimed);
→ registerResponseHandler(auditChannelDecision(handleChannelApprovalResponse));

registerMessageInterceptor(async (event) => (await channelNameInterceptor(event)).claimed);
→ registerMessageInterceptor(auditChannelNameInterceptor(channelNameInterceptor));
```

### 9. Boot wiring — `src/index.ts`

Insert inside `main()`, after the `migrateGroupsToClaudeLocal();` step and
before the container-runtime step:

```ts
  // Audit log (optional — installed by /add-audit; AUDIT_ENABLED gates writes).
  // The observer import self-registers approvals.decide; initAuditLog asserts
  // data/audit/ is writable when enabled (throw → exit 1) and starts hooks.
  await import('./modules/approvals/approvals-observer.audit.js');
  const { initAuditLog } = await import('./audit/index.js');
  initAuditLog();
```

### 10. Sweep wiring — `src/host-sweep.ts`

Insert inside `sweep()`, immediately before the `setTimeout(sweep, SWEEP_INTERVAL_MS);` reschedule:

```ts
  // Audit maintenance (installed by /add-audit) — retention prune (throttled
  // to once per UTC day inside the module) + post-write hooks' maintain().
  try {
    const { maintainAudit } = await import('./audit/index.js');
    maintainAudit();
  } catch (err) {
    log.error('Audit maintenance failed', { err });
  }
```

### 11. Enable it

Append to `.env` (this is the point of installing the skill — but the switch
stays yours):

```bash
AUDIT_ENABLED=true
# Optional; default 90. 0 = keep forever.
#AUDIT_RETENTION_DAYS=90
```

### 12. Verify

```bash
pnpm run build
pnpm exec vitest run src/audit src/audit-wiring.test.ts src/cli/dispatch.audit.test.ts \
  src/modules/approvals/primitive.audit.test.ts src/modules/approvals/response-handler.audit.test.ts \
  src/modules/approvals/approvals.audit.test.ts src/modules/permissions/permissions.audit.test.ts \
  src/modules/agent-to-agent/create-agent.audit.test.ts
pnpm test   # full suite — the composed system must stay green
```

Then restart the service (macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`,
Linux: `systemctl --user restart nanoclaw`).

## Usage

```bash
ncl audit list                                   # newest first, default limit 100
ncl audit list --actor host:moshe --since 7d
ncl audit list --outcome denied --since 90d --format ndjson   # SIEM export
ncl audit list --correlation appr-...            # everything on one gated chain
```

Host socket + `cli_scope: global` agents only; group-scoped agents never see
the resource (audit spans groups — exclusion fails closed). On a disabled box
the command errors with "audit log is disabled" rather than returning an
empty list that would read as history.

Exporters: call `registerAuditHook(...)` (from `src/audit/index.js`) in a
module imported at boot — `onEvent` fires only after a successful local
append, so an exporter can never know an event the source of truth doesn't.

## Semantics worth knowing

- **Fail-open + loud**: a failed append is `log.error`'d and the action
  proceeds; at boot (enabled only) the host refuses to start if `data/audit/`
  isn't writable.
- **Append-only**: nothing updates a line; retention prune unlinks whole
  day-files past `AUDIT_RETENTION_DAYS` (a literal hard delete).
- **No message bodies**: message-bearing events record shape only
  (`body_chars`, attachment names); a recursive key-pattern redactor masks
  secret-looking values at the emit seam.
