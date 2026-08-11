/** Byte-range source with an async `size()` — matches `CachedFilelike`. */
export interface AsyncByteRangeSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** `Filelike`-shaped adapter `@foxglove/rosbag`'s `Bag` requires for a remote source. */
export interface SyncSizeBagReadable {
  size: () => number;
  read: (offset: number, length: number) => Promise<Uint8Array>;
}

/**
 * Builds the `Filelike`-shaped adapter that `@foxglove/rosbag`'s `Bag` requires for a remote
 * source. `Filelike.size()` MUST be synchronous (`number`, never `Promise`/`bigint`) — the
 * library calls it directly without `await`, e.g. `this._file.size() - fileOffset` when
 * reading the connections/chunk index. Resolving the byte count once up front (rather than
 * exposing an `async`/`Promise`-returning `size()`) is what keeps that arithmetic from
 * silently becoming `NaN`. A `NaN` length there used to cause `CachedFilelike` to re-fetch the
 * same ~50MiB block forever, since a `NaN`-bounded read can never be marked satisfied (see
 * `CachedFilelike`'s input validation for the second line of defense against this class of
 * bug). Kept in its own module (rather than inline in `bag.worker.ts`) so the sync contract
 * can be regression-tested without importing a worker entrypoint that calls `Comlink.expose`
 * at module load time.
 */
export async function buildRemoteBagReadable(source: AsyncByteRangeSource): Promise<SyncSizeBagReadable> {
  const totalBytes = await source.size();
  return {
    size: () => totalBytes,
    read: (offset: number, length: number) => source.read(offset, length),
  };
}
