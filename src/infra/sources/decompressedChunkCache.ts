import type { McapTypes } from "@mcap/core";
import { pinTransferableBuffer } from "@/infra/workers/transferables";

const DEFAULT_MAX_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_SINGLE_ENTRY_SHARE = 0.5;

export interface CachedDecompressHandlersOptions {
  /** Maximum total uncompressed bytes retained across cached chunks. */
  maxBytes?: number;
  /**
   * Resolves a stable cache key (e.g. `${chunkOffset}:${chunkLength}`) for the
   * compressed slice's backing buffer. When undefined, decompression bypasses
   * the cache safely.
   */
  lookupChunkKey: (buffer: Uint8Array) => string | undefined;
}

/**
 * Bounded LRU cache for decompressed MCAP chunk payloads shared across every
 * `McapIndexedReader#readMessages` iterator in the worker (playback cursor,
 * H.264 bootstrap range scans, backfill, and Plot window reads).
 *
 * `@mcap/core` keeps its own `chunkViewCache` strictly local to each iterator,
 * so overlapping readers otherwise decompress the same zstd/lz4 chunks over and
 * over on the single MCAP worker thread. Cached backing ArrayBuffers are pinned
 * via `pinTransferableBuffer` so Transferable transport can never detach them.
 */
export function createCachedDecompressHandlers(
  base: McapTypes.DecompressHandlers,
  options: CachedDecompressHandlersOptions,
): McapTypes.DecompressHandlers {
  const maxBytes = Math.max(1024 * 1024, options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES);
  const maxEntryBytes = Math.floor(maxBytes * MAX_SINGLE_ENTRY_SHARE);
  const cache = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const wrap = (
    codec: string,
    handler: (buffer: Uint8Array, decompressedSize: bigint) => Uint8Array,
  ) => {
    return (buffer: Uint8Array, decompressedSize: bigint): Uint8Array => {
      const chunkKey = options.lookupChunkKey(buffer);
      if (!chunkKey) {
        return handler(buffer, decompressedSize);
      }
      const cacheKey = `${codec}:${chunkKey}:${buffer.byteOffset}:${buffer.byteLength}`;
      const existing = cache.get(cacheKey);
      if (existing && existing.buffer.byteLength > 0) {
        // Refresh recency (Map preserves insertion order).
        cache.delete(cacheKey);
        cache.set(cacheKey, existing);
        return existing;
      }
      if (existing) {
        totalBytes -= existing.byteLength;
        cache.delete(cacheKey);
      }

      const decompressed = handler(buffer, decompressedSize);
      if (decompressed.byteLength > 0 && decompressed.byteLength <= maxEntryBytes) {
        pinTransferableBuffer(decompressed.buffer);
        cache.set(cacheKey, decompressed);
        totalBytes += decompressed.byteLength;
        while (totalBytes > maxBytes) {
          const oldest = cache.entries().next();
          if (oldest.done) break;
          cache.delete(oldest.value[0]);
          totalBytes -= oldest.value[1].byteLength;
        }
      }
      return decompressed;
    };
  };

  const wrapped: McapTypes.DecompressHandlers = {};
  for (const [codec, handler] of Object.entries(base)) {
    if (handler) {
      wrapped[codec] = wrap(codec, handler);
    }
  }
  return wrapped;
}
