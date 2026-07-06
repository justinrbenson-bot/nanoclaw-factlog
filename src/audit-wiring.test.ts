/**
 * Wiring test for the audit log's two boot-path integration points.
 *
 * One colocated block lives in src/index.ts (dynamic import of
 * the self-registering approvals observer + `initAuditLog()`), and one in
 * src/host-sweep.ts (`maintainAudit()` inside the sweep, fail-isolated). A
 * behavioral test can't see whether those edits are present and correctly
 * placed — booting the real host is too heavy — so this asserts them
 * structurally, via the TypeScript AST:
 *   - the observer module is dynamically imported by its correct path and
 *     initAuditLog() runs after it (registration before enablement),
 *   - both are DIRECT statements of main()'s body, after DB init and before
 *     the boot-complete log,
 *   - maintainAudit() is called inside sweep() before the reschedule.
 *
 * Delete or misplace a block and this goes red. The seam wrappers themselves
 * are covered behaviorally (dispatch.audit.test.ts and friends).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

function bodyOf(file: string, fnName: string): { stmts: ts.NodeArray<ts.Statement>; sf: ts.SourceFile } {
  const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let body: ts.NodeArray<ts.Statement> | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName && n.body) {
      body = n.body.statements;
    }
  });
  if (!body) throw new Error(`${fnName}() not found in ${file}`);
  return { stmts: body, sf };
}

/** `await import('<path>')` as a bare expression statement. */
function isAwaitedImportStatement(s: ts.Statement, importPath: string): boolean {
  return (
    ts.isExpressionStatement(s) &&
    ts.isAwaitExpression(s.expression) &&
    ts.isCallExpression(s.expression.expression) &&
    s.expression.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    ts.isStringLiteral(s.expression.expression.arguments[0]!) &&
    (s.expression.expression.arguments[0] as ts.StringLiteral).text === importPath
  );
}

/** `const { ... } = await import('<path>')` as a statement. */
function isDynamicImportBinding(s: ts.Statement, importPath: string): boolean {
  if (!ts.isVariableStatement(s)) return false;
  const init = s.declarationList.declarations[0]?.initializer;
  if (!init || !ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return false;
  const call = init.expression;
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const arg = call.arguments[0];
  return !!arg && ts.isStringLiteral(arg) && arg.text === importPath;
}

function isBareCall(s: ts.Statement, callee: string): boolean {
  return (
    ts.isExpressionStatement(s) &&
    ts.isCallExpression(s.expression) &&
    ts.isIdentifier(s.expression.expression) &&
    s.expression.expression.text === callee
  );
}

describe('audit wiring in src/index.ts', () => {
  it('imports the self-registering observer, then initAuditLog(), colocated in main() after DB init and before the boot-complete log', () => {
    const { stmts, sf } = bodyOf('src/index.ts', 'main');
    const observerIdx = stmts.findIndex((s) =>
      isAwaitedImportStatement(s, './modules/approvals/approvals-observer.audit.js'),
    );
    const importIdx = stmts.findIndex((s) => isDynamicImportBinding(s, './audit/index.js'));
    const callIdx = stmts.findIndex((s) => isBareCall(s, 'initAuditLog'));
    const migrateIdx = stmts.findIndex((s) => s.getText(sf).includes('runMigrations('));
    const runningIdx = stmts.findIndex((s) => s.getText(sf).includes("log.info('NanoClaw running')"));

    expect(observerIdx, 'the observer must be dynamically imported in main()').toBeGreaterThanOrEqual(0);
    expect(importIdx, "dynamic import('./audit/index.js') must be a statement of main()").toBeGreaterThanOrEqual(0);
    expect(callIdx, 'initAuditLog() must be a statement of main()').toBeGreaterThanOrEqual(0);
    expect(migrateIdx, 'runMigrations() anchor not found').toBeGreaterThanOrEqual(0);
    expect(runningIdx, 'boot-complete log anchor not found').toBeGreaterThanOrEqual(0);
    expect(observerIdx, 'the observer import must come after DB init').toBeGreaterThan(migrateIdx);
    expect(importIdx, 'the audit import must come after the observer import').toBeGreaterThan(observerIdx);
    expect(callIdx, 'initAuditLog() must come after its import (colocated)').toBeGreaterThan(importIdx);
    expect(callIdx, 'initAuditLog() must run before the boot-complete log').toBeLessThan(runningIdx);
  });
});

describe('audit wiring in src/host-sweep.ts', () => {
  it('calls maintainAudit() inside sweep(), fail-isolated, before the reschedule', () => {
    const { stmts, sf } = bodyOf('src/host-sweep.ts', 'sweep');
    const auditIdx = stmts.findIndex((s) => ts.isTryStatement(s) && s.getText(sf).includes('maintainAudit()'));
    const rescheduleIdx = stmts.findIndex((s) => s.getText(sf).includes('setTimeout(sweep'));

    expect(auditIdx, 'a try-wrapped maintainAudit() must be a statement of sweep()').toBeGreaterThanOrEqual(0);
    expect(rescheduleIdx, 'setTimeout(sweep) anchor not found').toBeGreaterThanOrEqual(0);
    expect(auditIdx, 'maintainAudit() must run before the sweep reschedules itself').toBeLessThan(rescheduleIdx);
  });
});
