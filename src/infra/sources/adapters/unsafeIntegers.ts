const TIME_LIKE_KEY = /(_ns|nsec|nanosec|stamp|time)$/i;
const MAX_DEPTH = 6;

/**
 * Paths of time-like integer fields above `Number.MAX_SAFE_INTEGER`: a JSON
 * number like `1794223925884797015` silently decodes to `...797000`. Only
 * time-like keys are reported, since large floats are legitimate elsewhere.
 */
export function findUnsafeIntegerFields(message: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH || typeof value !== 'object' || value == null || ArrayBuffer.isView(value)) return;
    if (Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === 'number' && Number.isInteger(child) && child > Number.MAX_SAFE_INTEGER) {
        if (TIME_LIKE_KEY.test(key)) out.push(childPath);
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(message, '', 0);
  return out;
}
