import type { MeshStrategy } from './recipe';

export type MeshProbeStatus =
  | 'pending'
  | 'ok'
  | 'local'
  | 'missing'
  | 'error'
  | 'cors'
  | 'unchecked';

export type MeshReferenceStatus = {
  rawPath: string;
  resolvedUrl: string;
  status: MeshProbeStatus;
  error?: string;
};

export function normalizeRemoteBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!/^https?:\/\/.+/i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

export function extractPackageNameFromUrdf(urdfText: string): string | null {
  const match = /package:\/\/([^/\s"']+)\//.exec(urdfText);
  return match?.[1] ?? null;
}

export function dedupeMeshReferences(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

export function inferProbeStatusBeforeFetch(
  rawPath: string,
  resolvedUrl: string,
  strategy: MeshStrategy,
): Pick<MeshReferenceStatus, 'status' | 'error'> {
  if (strategy === 'leaveAsIs') {
    return { status: 'unchecked' };
  }
  if (resolvedUrl.startsWith('blob:')) {
    return { status: 'local' };
  }
  if (!resolvedUrl || resolvedUrl === rawPath) {
    if (rawPath.startsWith('package://') || strategy === 'localUpload') {
      return { status: 'missing', error: 'No matching local file' };
    }
  }
  if (strategy === 'localUpload' && !resolvedUrl.startsWith('blob:')) {
    return { status: 'missing', error: 'No matching local file' };
  }
  if (strategy === 'packageBaseUrl') {
    if (!/^https?:\/\//i.test(resolvedUrl)) {
      return { status: 'missing', error: 'Base URL not applied or invalid' };
    }
  }
  if (/^https?:\/\//i.test(resolvedUrl)) {
    return { status: 'pending' };
  }
  return { status: 'unchecked' };
}

export async function probeRemoteMeshUrl(url: string): Promise<Pick<MeshReferenceStatus, 'status' | 'error'>> {
  try {
    let response = await fetch(url, { method: 'HEAD', mode: 'cors' });
    if (response.ok) return { status: 'ok' };
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (response.ok || response.status === 206) return { status: 'ok' };
    }
    return { status: 'error', error: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|cors|network/i.test(message)) {
      return { status: 'cors', error: message };
    }
    return { status: 'error', error: message };
  }
}

export async function buildMeshReferenceStatuses(args: {
  meshReferences: string[];
  resolveMeshUrl: (rawPath: string) => string;
  strategy: MeshStrategy;
}): Promise<MeshReferenceStatus[]> {
  const refs = dedupeMeshReferences(args.meshReferences);
  const preliminary = refs.map((rawPath) => {
    const resolvedUrl = args.resolveMeshUrl(rawPath);
    const inferred = inferProbeStatusBeforeFetch(rawPath, resolvedUrl, args.strategy);
    return { rawPath, resolvedUrl, ...inferred };
  });

  return Promise.all(
    preliminary.map(async (entry) => {
      if (entry.status !== 'pending') return entry;
      const remote = await probeRemoteMeshUrl(entry.resolvedUrl);
      return { ...entry, ...remote };
    }),
  );
}

export function summarizeMeshStatuses(entries: MeshReferenceStatus[]): {
  ok: number;
  failed: number;
  total: number;
} {
  const okStatuses: MeshProbeStatus[] = ['ok', 'local', 'unchecked'];
  const ok = entries.filter((entry) => okStatuses.includes(entry.status)).length;
  return { ok, failed: entries.length - ok, total: entries.length };
}
