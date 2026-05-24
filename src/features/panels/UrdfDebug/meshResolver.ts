import type { MeshStrategy } from './recipe';

export type MeshResolverOptions = {
  strategy: MeshStrategy;
  packageName?: string;
  packageBaseUrl?: string;
  localUrls: Map<string, string>;
  defaultRemoteBase?: string;
};

const DEFAULT_REMOTE_BASE = 'https://assets.embodiflow.com/resources';

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function basename(path: string): string {
  const clean = path.split('?')[0] ?? path;
  const parts = clean.split('/');
  return parts[parts.length - 1] ?? clean;
}

function lookupLocal(localUrls: Map<string, string>, rawPath: string): string | undefined {
  const file = basename(rawPath);
  if (localUrls.has(rawPath)) return localUrls.get(rawPath);
  if (localUrls.has(file)) return localUrls.get(file);
  const meshSuffix = rawPath.includes('meshes/') ? rawPath.slice(rawPath.indexOf('meshes/')) : undefined;
  if (meshSuffix && localUrls.has(meshSuffix)) return localUrls.get(meshSuffix);
  return undefined;
}

export function buildLocalMeshUrlMap(files: File[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    const url = URL.createObjectURL(file);
    map.set(file.name, url);
    if (file.webkitRelativePath) {
      map.set(file.webkitRelativePath, url);
      const meshIdx = file.webkitRelativePath.indexOf('meshes/');
      if (meshIdx >= 0) {
        map.set(file.webkitRelativePath.slice(meshIdx), url);
      }
    }
  }
  return map;
}

export function revokeMeshUrlMap(map: Map<string, string>): void {
  for (const url of map.values()) {
    URL.revokeObjectURL(url);
  }
  map.clear();
}

export function createMeshResolver(options: MeshResolverOptions): (rawPath: string) => string {
  const globalConfig = typeof window !== 'undefined'
    ? (window as Window & {
        __ROS_STUDIO_URDF_PACKAGE_BASE__?: string;
        __ROS_STUDIO_URDF_PACKAGE_BASES__?: Record<string, string>;
      })
    : undefined;
  const envBase = import.meta.env.VITE_ROS_STUDIO_URDF_PACKAGE_BASE?.trim();
  const defaultBase = normalizeBase(
    options.defaultRemoteBase ??
      globalConfig?.__ROS_STUDIO_URDF_PACKAGE_BASE__ ??
      envBase ??
      DEFAULT_REMOTE_BASE,
  );

  return (rawPath: string) => {
    if (/^https?:\/\//i.test(rawPath)) return rawPath;

    const remoteBaseApplied =
      options.strategy === 'packageBaseUrl' && Boolean(options.packageBaseUrl?.trim());

    if (options.strategy === 'localUpload') {
      const local = lookupLocal(options.localUrls, rawPath);
      if (local) return local;
    }

    if (options.strategy === 'leaveAsIs' && !rawPath.startsWith('package://')) {
      return rawPath;
    }

    if (rawPath.startsWith('/')) {
      const absolutePath = rawPath.replace(/^\/+/, '');
      if (remoteBaseApplied && options.packageBaseUrl) {
        return `${normalizeBase(options.packageBaseUrl)}/${absolutePath}`;
      }
      if (options.strategy !== 'packageBaseUrl') {
        return `${defaultBase}/${absolutePath}`;
      }
      return rawPath;
    }

    if (rawPath.startsWith('package://')) {
      const packagePath = rawPath.slice('package://'.length);
      const firstSlash = packagePath.indexOf('/');
      const packageName = firstSlash >= 0 ? packagePath.slice(0, firstSlash) : packagePath;
      const insidePackagePath = firstSlash >= 0 ? packagePath.slice(firstSlash + 1) : '';

      if (options.strategy === 'localUpload') {
        const local = lookupLocal(options.localUrls, insidePackagePath);
        if (local) return local;
      }

      if (remoteBaseApplied && options.packageBaseUrl) {
        return insidePackagePath
          ? `${normalizeBase(options.packageBaseUrl)}/${insidePackagePath}`
          : normalizeBase(options.packageBaseUrl);
      }

      if (options.strategy === 'packageBaseUrl') {
        return rawPath;
      }

      const packageBase = globalConfig?.__ROS_STUDIO_URDF_PACKAGE_BASES__?.[packageName];
      if (packageBase) {
        const resolvedBase = normalizeBase(packageBase);
        return insidePackagePath ? `${resolvedBase}/${insidePackagePath}` : resolvedBase;
      }

      if (options.packageName && packageName !== options.packageName) {
        return `${defaultBase}/${packagePath}`;
      }
      return `${defaultBase}/${packagePath}`;
    }

    if (remoteBaseApplied && options.packageBaseUrl) {
      return `${normalizeBase(options.packageBaseUrl)}/${rawPath}`;
    }

    return rawPath;
  };
}
