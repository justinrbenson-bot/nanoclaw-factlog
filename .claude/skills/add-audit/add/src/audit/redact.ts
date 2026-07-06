/**
 * Recursive details redaction — runs at the single emit seam so every current
 * and future surface is guarded by default. Two rules:
 *   1. Any key matching the sensitive pattern is masked to '[REDACTED]'
 *      (the value is never inspected or recursed into).
 *   2. Strings are truncated to ~2 KB post-redaction.
 *
 * Message bodies are excluded upstream by the per-surface mappers (shape only:
 * body_chars, attachment names) — this mask is defense-in-depth, not the
 * mechanism that keeps chat content out of the log.
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
  // Depth cap doubles as a cheap cycle guard — details payloads are
  // JSON-serializable in practice, but the emit path must never throw.
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  return redactObject(value as Record<string, unknown>, depth);
}
