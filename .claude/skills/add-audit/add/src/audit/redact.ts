/**
 * The one redactor, applied to every event's `details` at the emit seam —
 * guarding current and future surfaces by default. Key-pattern mask plus a
 * per-value size cap; message bodies are never passed in (emit sites record
 * shape only — the audit log is a governance record, not a chat archive).
 */

const SENSITIVE_KEY = /(token|secret|key|password|credential|auth|bearer)/i;
const MAX_VALUE_CHARS = 2048;
const MAX_DEPTH = 8;

export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactObject(details, 0);
}

function redactObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  return redactObject(value as Record<string, unknown>, depth);
}
