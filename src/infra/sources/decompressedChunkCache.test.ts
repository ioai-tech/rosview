import { describe, expect, it, vi } from "vitest";
import { collectTransferables } from "@/infra/workers/transferables";
import { createCachedDecompressHandlers } from "./decompressedChunkCache";

describe("createCachedDecompressHandlers", () => {
  it("reuses decompressed chunks on repeated reads and pins cached buffers against transfer", () => {
    const rawDecompress = vi.fn((input: Uint8Array, size: bigint) => {
      const out = new Uint8Array(Number(size));
      out.fill(input[0] ?? 0);
      return out;
    });
    const keys = new WeakMap<ArrayBufferLike, string>();
    const handlers = createCachedDecompressHandlers(
      { zstd: rawDecompress },
      { maxBytes: 4 * 1024 * 1024, lookupChunkKey: (buf) => keys.get(buf.buffer) },
    );

    const compressed = new Uint8Array([42, 1, 2, 3]);
    keys.set(compressed.buffer, "100:4");

    const first = handlers.zstd(compressed, 1024n);
    const second = handlers.zstd(compressed, 1024n);

    expect(rawDecompress).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(collectTransferables([{ data: second }])).toEqual([]);
  });

  it("evicts least-recently-used entries once the byte budget is exceeded", () => {
    const rawDecompress = vi.fn((_input: Uint8Array, size: bigint) => new Uint8Array(Number(size)));
    const keys = new WeakMap<ArrayBufferLike, string>();
    const handlers = createCachedDecompressHandlers(
      { zstd: rawDecompress },
      { maxBytes: 1024 * 1024, lookupChunkKey: (buf) => keys.get(buf.buffer) },
    );

    const makeChunk = (id: string) => {
      const buf = new Uint8Array([1, 2, 3, 4]);
      keys.set(buf.buffer, id);
      return buf;
    };

    const a = makeChunk("a");
    const b = makeChunk("b");
    const c = makeChunk("c");
    const entrySize = BigInt(400 * 1024);

    handlers.zstd(a, entrySize);
    handlers.zstd(b, entrySize);
    // Touch `a` so `b` becomes least recently used.
    handlers.zstd(a, entrySize);
    // Adding `c` pushes total to 1200 KiB > 1024 KiB, evicting `b`.
    handlers.zstd(c, entrySize);

    expect(rawDecompress).toHaveBeenCalledTimes(3);
    handlers.zstd(a, entrySize);
    expect(rawDecompress).toHaveBeenCalledTimes(3);
    handlers.zstd(b, entrySize);
    expect(rawDecompress).toHaveBeenCalledTimes(4);
  });
});
