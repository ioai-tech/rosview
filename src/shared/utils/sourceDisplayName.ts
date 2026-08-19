/** Basename for a URL or local filename, used in the loading overlay and navbar. */
export function sourceDisplayName(sourceName?: string): string | undefined {
  if (!sourceName) {
    return undefined;
  }
  const trimmed = sourceName.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    const base = url.pathname.split('/').filter(Boolean).pop();
    return base ? decodeURIComponent(base) : trimmed;
  } catch {
    const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  }
}
