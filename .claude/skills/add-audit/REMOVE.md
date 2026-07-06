# Remove /add-audit

Reverses every change apply made. The audit day-files under `data/audit/` are
the operator's records — this removes the recorder, not the recordings; delete
`data/audit/` yourself if you also want the history gone.

## 1. Delete every copied file

```bash
rm -rf src/audit
rm -f src/audit-wiring.test.ts \
      src/cli/dispatch.audit.ts src/cli/dispatch.audit.test.ts \
      src/cli/resources/audit.ts \
      src/modules/approvals/approvals.audit.ts src/modules/approvals/approvals.audit.test.ts \
      src/modules/approvals/approvals-observer.audit.ts \
      src/modules/approvals/primitive.audit.test.ts src/modules/approvals/response-handler.audit.test.ts \
      src/modules/permissions/permissions.audit.ts src/modules/permissions/permissions.audit.test.ts \
      src/modules/agent-to-agent/create-agent.audit.ts src/modules/agent-to-agent/create-agent.audit.test.ts
```

## 2. Revert the seam compositions (DELETE lines, do not comment out)

- `src/cli/resources/index.ts`: delete the `import './audit.js';` line.
- `src/cli/dispatch.ts`: delete the `import { withAudit } from './dispatch.audit.js';`
  line and the `export const dispatch = withAudit(dispatchInner);` block (with
  its comment); rename `async function dispatchInner(` back to
  `export async function dispatch(`.
- `src/modules/approvals/primitive.ts`: delete the
  `import { auditRequestApproval } from './approvals.audit.js';` line (and its
  comment) and the `export const requestApproval = auditRequestApproval(...)`
  block; rename `async function requestApprovalInner(` back to
  `export async function requestApproval(`.
- `src/modules/approvals/response-handler.ts`: delete the
  `import { runApprovedHandler } from './approvals.audit.js';` line; replace the
  `await runApprovedHandler(...)` call (and its comment) with:
  `await handler({ session, payload, userId, approvalId: approval.approval_id, notify });`
- `src/modules/approvals/onecli-approvals.ts`: delete the adapter import line,
  the `recordOneCliHold` const (change `recordOneCliHold({` back to
  `createPendingApproval({`), and the three wrapper consts (with comments);
  rename the three `...Inner` functions back (`resolveOneCLIApprovalInner` →
  `export function resolveOneCLIApproval`, `expireApprovalInner` →
  `expireApproval`, `sweepStaleApprovalsInner` → `sweepStaleApprovals`).
- `src/modules/permissions/index.ts`: delete the adapter import line; restore
  the three plain registrations:
  ```ts
  registerResponseHandler(async (payload) => (await handleSenderApprovalResponse(payload)).claimed);
  registerResponseHandler(async (payload) => (await handleChannelApprovalResponse(payload)).claimed);
  registerMessageInterceptor(async (event) => (await channelNameInterceptor(event)).claimed);
  ```
- `src/index.ts`: delete the audit block in `main()` (the comment, the two
  `await import(...)` lines, and `initAuditLog();`).
- `src/host-sweep.ts`: delete the audit-maintenance `try { ... }` block in
  `sweep()` (with its comment).

## 3. Revert config and env

- `src/config.ts`: remove `'AUDIT_ENABLED',` and `'AUDIT_RETENTION_DAYS',`
  from the `readEnvFile([...])` array, and delete the
  `AUDIT_ENABLED` / `AUDIT_RETENTION_DAYS` export block (with its comments).
- `.env`: remove the `AUDIT_ENABLED` and `AUDIT_RETENTION_DAYS` lines.

## 4. Verify

```bash
pnpm run build && pnpm test
```

Then restart the service.
