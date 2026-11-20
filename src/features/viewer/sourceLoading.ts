/**
 * Pure helpers for turning a `DatasetItem` into a ready-to-initialize player
 * source (Worker + `WorkerSerializedSource` + init args). No React here —
 * this is plain async/data logic shared by the single-file fast path and
 * the multi-file `CombinedSourceProxy` path in `RosViewerImpl`.
 */
import { WorkerSerializedSource } from '@/infra/workers/WorkerSerializedSource';
import type { CombinedSourceMember } from '@/infra/workers/CombinedSourceProxy';
import {
  loadHdf5WasmBinary,
  loadSqlWasmBinary,
  loadZstdWasmBinary,
  needsZstdWasmForWorker,
} from '@/infra/workers/preloadWorkerWasm';
import { isRosRecordingFilename, type DatasetItem } from '@/shared/utils/datasetSources';
import { resolveBrowserHttpUrl } from '@/shared/utils/resolveBrowserHttpUrl';
import { RangeSource } from '@/infra/range/RangeSource';
import { exposeRangeSource, type ExposedRangeSource } from '@/infra/range/rangeHandle';
import { rangeBlockCache } from '@/infra/range/rangeCache';
import type { UrlRenewal } from '@/infra/range/urlRenewal';
import { resolveRemoteCacheBytes } from '@/infra/workers/remoteCacheConfig';

/**
 * Test seam, compiled in only for `vite build --mode e2e` (production and library builds drop it):
 * `window.__rosviewStallTimeoutMs` shortens the range reader's stall timeout so stall tests run in
 * seconds instead of the default 20 s.
 */
function e2eStallTimeoutMs(): number | undefined {
  if (import.meta.env.MODE !== 'e2e' || typeof window === 'undefined') return undefined;
  const ms = (window as unknown as { __rosviewStallTimeoutMs?: unknown }).__rosviewStallTimeoutMs;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}

/** Per-viewer settings for how remote recordings are read. */
export interface RemoteReadOptions {
  renewal?: UrlRenewal;
  /** Host-stable id of the (single) recording; enables cache reuse across opens. */
  sourceKey?: string;
  /** False when the host turned persistence off: nothing about the recording may reach IndexedDB. */
  persist?: boolean;
}

/** True for the formats that read through a `RangeSource` (everything remote except bvh / hdf5). */
function usesRangeSource(ext: string | undefined): boolean {
  return ext !== 'bvh' && ext !== 'hdf5' && ext !== 'h5';
}

export function extensionForDataset(ds: DatasetItem): string | undefined {
  if (ds.kind === 'file' && ds.file) {
    return ds.file.name.split('.').pop()?.toLowerCase();
  }
  if (ds.kind === 'url' && ds.url) {
    try {
      const path = new URL(ds.url).pathname;
      return path.split('.').pop()?.toLowerCase();
    } catch {
      return ds.url.split('.').pop()?.toLowerCase();
    }
  }
  return undefined;
}

export async function createWorkerForExtension(ext: string | undefined): Promise<Worker> {
  if (ext === 'bvh') {
    const { default: BvhWorkerClass } = await import('@/infra/workers/bvh.worker.ts?worker&inline');
    return new BvhWorkerClass();
  }
  if (ext === 'bag') {
    const { default: BagWorkerClass } = await import('@/infra/workers/bag.worker.ts?worker&inline');
    return new BagWorkerClass();
  }
  if (ext === 'db3') {
    const { default: Db3WorkerClass } = await import('@/infra/workers/db3.worker.ts?worker&inline');
    return new Db3WorkerClass();
  }
  if (ext === 'hdf5' || ext === 'h5') {
    const { default: Hdf5WorkerClass } = await import('@/infra/workers/hdf5.worker.ts?worker&inline');
    return new Hdf5WorkerClass();
  }
  const { default: McapWorkerClass } = await import('@/infra/workers/mcap.worker.ts?worker&inline');
  return new McapWorkerClass();
}

export async function buildInitArgsForDataset(
  ds: DatasetItem,
  ext: string | undefined,
  autoDataQualityScan: boolean,
  remote?: { exposed: ExposedRangeSource },
): Promise<Record<string, unknown>> {
  const workerPerf =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('workerPerf') === '1';
  const sqlWasmBinary = ext === 'db3' ? await loadSqlWasmBinary() : undefined;
  const hdf5WasmBinary = ext === 'hdf5' || ext === 'h5' ? await loadHdf5WasmBinary() : undefined;
  const zstdWasmBinary = needsZstdWasmForWorker(ext) ? await loadZstdWasmBinary() : undefined;
  if (ds.kind === 'url' && ds.url) {
    const init: Record<string, unknown> = {
      url: resolveBrowserHttpUrl(ds.url),
      workerPerf,
      autoDataQualityScan,
    };
    if (ext === 'db3') {
      init.sqlWasmBinary = sqlWasmBinary;
    }
    if (hdf5WasmBinary) {
      init.hdf5WasmBinary = hdf5WasmBinary;
    }
    if (zstdWasmBinary) {
      init.zstdWasmBinary = zstdWasmBinary;
    }
    if (typeof ds.sizeBytes === 'number' && Number.isFinite(ds.sizeBytes) && ds.sizeBytes > 0) {
      init.knownTotalBytes = Math.floor(ds.sizeBytes);
    }
    if (remote) {
      init.rangePort = remote.exposed.port;
      init.rangeCacheBytes = rangeBlockCache.maxBytes;
    }
    return init;
  }
  if (ds.kind === 'file' && ds.file) {
    const siblingFiles = ds.siblingFiles?.filter((file) => isRosRecordingFilename(file.name)) ?? [];
    const files = siblingFiles.length > 0 ? siblingFiles : [ds.file];
    if (ext === 'bag' || ext === 'db3') {
      return {
        file: ds.file,
        files,
        workerPerf,
        autoDataQualityScan,
        ...(sqlWasmBinary ? { sqlWasmBinary } : {}),
        ...(zstdWasmBinary ? { zstdWasmBinary } : {}),
      };
    }
    return {
      file: ds.file,
      workerPerf,
      autoDataQualityScan,
      ...(hdf5WasmBinary ? { hdf5WasmBinary } : {}),
      ...(zstdWasmBinary ? { zstdWasmBinary } : {}),
    };
  }
  throw new Error('Invalid dataset item');
}

/**
 * Creates a Worker + `WorkerSerializedSource` + init args for one dataset
 * member. Shared by both the single-file fast path and the multi-file
 * `CombinedSourceProxy` path so a group of 1 behaves byte-for-byte like
 * today's single-source loading.
 */
export async function prepareSourceMember(
  ds: DatasetItem,
  autoDataQualityScan: boolean,
  remoteOptions: RemoteReadOptions = {},
): Promise<{ member: CombinedSourceMember; ext: string | undefined }> {
  const ext = extensionForDataset(ds);
  const worker = await createWorkerForExtension(ext);
  worker.onerror = (ev) => console.error('MAIN: Worker error', ev);
  let exposed: ExposedRangeSource | undefined;
  if (ds.kind === 'url' && ds.url && usesRangeSource(ext)) {
    rangeBlockCache.setMaxBytes(resolveRemoteCacheBytes());
    const renewal = remoteOptions.renewal;
    const rangeSource = new RangeSource({
      url: ds.url,
      resolveUrl: resolveBrowserHttpUrl,
      sourceKey: remoteOptions.sourceKey,
      knownTotalBytes: ds.sizeBytes,
      renewal,
      stallTimeoutMs: e2eStallTimeoutMs(),
    });
    exposed = exposeRangeSource(rangeSource, {
      indexKey: remoteOptions.sourceKey,
      renewUrl: renewal
        ? async (failed) => ((await renewal.renew(rangeSource, failed)) ? rangeSource.getUrl() : undefined)
        : undefined,
    });
  }
  const initArgs = await buildInitArgsForDataset(ds, ext, autoDataQualityScan, exposed ? { exposed } : undefined);
  if (remoteOptions.persist === false) initArgs.persistIndex = false;
  const source = new WorkerSerializedSource(worker);
  if (exposed) source.addDisposer(() => exposed.dispose());
  return { member: { label: ds.name, source, initArgs }, ext };
}

/** Try indices in order: startIdx .. end-1, then 0 .. startIdx-1 */
export function fallbackIndexOrder(length: number, startIdx: number): number[] {
  if (length <= 0) return [];
  const s = Math.max(0, Math.min(startIdx, length - 1));
  const out: number[] = [];
  for (let i = s; i < length; i++) out.push(i);
  for (let i = 0; i < s; i++) out.push(i);
  return out;
}
