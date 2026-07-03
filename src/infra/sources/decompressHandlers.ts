import type { McapTypes } from "@mcap/core";
import * as lz4js from "lz4js";
import { decompress as zstdDecompress } from "@ioai/wasm-zstd";
import { ensureZstdRuntime } from "@/infra/workers/zstdRuntimeLoader";

export type LoadDecompressHandlersOptions = {
  wasmBinary: ArrayBuffer;
};

export async function loadDecompressHandlers(
  options: LoadDecompressHandlersOptions,
): Promise<McapTypes.DecompressHandlers> {
  await ensureZstdRuntime(options.wasmBinary);

  return {
    lz4: (buffer, decompressedSize) => {
      // Check if it is an LZ4 frame (magic number 0x184D2204)
      if (
        buffer.length >= 4 &&
        buffer[0] === 0x04 &&
        buffer[1] === 0x22 &&
        buffer[2] === 0x4d &&
        buffer[3] === 0x18
      ) {
        return lz4js.decompress(buffer);
      }

      const output = new Uint8Array(Number(decompressedSize));
      const result = lz4js.decompressBlock(buffer, output, 0, buffer.byteLength, 0);
      if (result < 0) {
        throw new Error(`lz4 decompression failed (result=${result})`);
      }
      return output;
    },
    zstd: (buffer, decompressedSize) => {
      return zstdDecompress(buffer, Number(decompressedSize));
    },
  };
}
