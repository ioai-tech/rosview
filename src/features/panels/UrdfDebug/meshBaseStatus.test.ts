import { describe, expect, it } from 'vitest';
import {
  buildMeshReferenceStatuses,
  dedupeMeshReferences,
  extractPackageNameFromUrdf,
  inferProbeStatusBeforeFetch,
  normalizeRemoteBaseUrl,
  summarizeMeshStatuses,
} from './meshBaseStatus';
import { createMeshResolver } from './meshResolver';

describe('meshBaseStatus', () => {
  it('normalizes remote base URL', () => {
    expect(normalizeRemoteBaseUrl('https://example.com/meshes/')).toBe('https://example.com/meshes');
    expect(normalizeRemoteBaseUrl('ftp://x.com')).toBeNull();
    expect(normalizeRemoteBaseUrl('  ')).toBeNull();
  });

  it('extracts package name from URDF', () => {
    const urdf = '<mesh filename="package://xArm7/meshes/link1.stl"/>';
    expect(extractPackageNameFromUrdf(urdf)).toBe('xArm7');
  });

  it('dedupes mesh references', () => {
    expect(dedupeMeshReferences(['a.stl', 'a.stl', ''])).toEqual(['a.stl']);
  });

  it('marks missing local files', () => {
    const inferred = inferProbeStatusBeforeFetch(
      'package://Robot/meshes/base.stl',
      'package://Robot/meshes/base.stl',
      'localUpload',
    );
    expect(inferred.status).toBe('missing');
  });

  it('resolves remote URLs and reports pending probe', async () => {
    const resolver = createMeshResolver({
      strategy: 'packageBaseUrl',
      packageBaseUrl: 'https://cdn.example.com/xArm7/meshes',
      localUrls: new Map(),
    });
    const statuses = await buildMeshReferenceStatuses({
      meshReferences: ['package://xArm7/meshes/base.stl'],
      resolveMeshUrl: resolver,
      strategy: 'packageBaseUrl',
    });
    expect(statuses[0]?.resolvedUrl).toBe('https://cdn.example.com/xArm7/meshes/meshes/base.stl');
    expect(['pending', 'ok', 'error', 'cors']).toContain(statuses[0]?.status);
  });

  it('summarizes mesh statuses', () => {
    const summary = summarizeMeshStatuses([
      { rawPath: 'a', resolvedUrl: 'blob:x', status: 'local' },
      { rawPath: 'b', resolvedUrl: 'https://x', status: 'error' },
    ]);
    expect(summary).toEqual({ ok: 1, failed: 1, total: 2 });
  });
});
