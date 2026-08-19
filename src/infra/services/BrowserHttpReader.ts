export type HttpReadProgress = (received: number, expected: number) => void;

export interface HttpReader {
  size(): number;
  read(offset: number, length: number, signal?: AbortSignal, onProgress?: HttpReadProgress): Promise<Uint8Array>;
}

export type BrowserHttpReaderOptions = {
  /**
   * Optional hint from a dataset manifest (`sizeBytes`). When set, skips the
   * initial Range probe. For presigned S3 URLs, prefer fixing bucket CORS so
   * `Content-Range` / `Content-Length` are exposed and this can stay unset.
   */
  knownTotalBytes?: number;
};

/** Parallel byte-range GETs for wide reads (S3-friendly throughput). */
const RANGE_PART_BYTES = 8 * 1024 * 1024;
const RANGE_PARALLEL_MIN_TOTAL_BYTES = 8 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_MS = 300;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      },
      { once: true },
    );
  });
}

export class BrowserHttpReader implements HttpReader {
  private _url: string;
  private _knownTotalBytes?: number;
  private _size: number = -1;

  constructor(url: string, options?: BrowserHttpReaderOptions) {
    this._url = url;
    this._knownTotalBytes = options?.knownTotalBytes;
  }

  async initialize(): Promise<void> {
    if (
      typeof this._knownTotalBytes === 'number' &&
      Number.isFinite(this._knownTotalBytes) &&
      this._knownTotalBytes > 0
    ) {
      this._size = Math.floor(this._knownTotalBytes);
      return;
    }

    // Range GET (bytes=0-0): works with presigned GET URLs (HEAD uses a different signature).
    // Requires bucket CORS ExposeHeaders to include Content-Range and/or Content-Length.
    const probe = await this.#fetchWithRetry(this._url, { headers: { Range: 'bytes=0-0' } });
    if (!probe.ok && probe.status !== 206) {
      throw new Error(`Failed to fetch ${this._url}: ${probe.status} ${probe.statusText}`);
    }
    if (probe.status === 206) {
      const contentRange = probe.headers.get('Content-Range');
      const totalMatch = contentRange && /\/(\d+)\s*$/.exec(contentRange);
      if (totalMatch) {
        this._size = parseInt(totalMatch[1], 10);
      }
    } else if (probe.ok) {
      const cl = probe.headers.get('Content-Length');
      if (cl) {
        this._size = parseInt(cl, 10);
      } else {
        const buf = await probe.arrayBuffer();
        this._size = buf.byteLength;
      }
    }
    if (this._size <= 0) {
      throw new Error(
        `Could not determine file size for ${this._url} (no Content-Range or Content-Length). ` +
          `Ensure the S3 bucket CORS rule exposes Content-Range, Content-Length, and Accept-Ranges for your app origin.`,
      );
    }
    if (import.meta.env.DEV) {
      const acceptRanges = probe.headers.get('Accept-Ranges');
      if (!acceptRanges || acceptRanges === 'none') {
        console.debug(
          `Accept-Ranges header not explicitly found or set to none, but proceeding with Range requests: ${this._url}`,
        );
      }
    }
  }

  size(): number {
    return this._size;
  }

  async read(
    offset: number,
    length: number,
    signal?: AbortSignal,
    onProgress?: HttpReadProgress,
  ): Promise<Uint8Array> {
    if (length === 0) {
      return new Uint8Array();
    }
    if (length >= RANGE_PARALLEL_MIN_TOTAL_BYTES) {
      const parts: Array<{ start: number; len: number }> = [];
      for (let pos = offset; pos < offset + length; pos += RANGE_PART_BYTES) {
        parts.push({ start: pos, len: Math.min(RANGE_PART_BYTES, offset + length - pos) });
      }
      const receivedByPart = new Array<number>(parts.length).fill(0);
      const chunks = await Promise.all(
        parts.map(({ start, len }, index) =>
          this.#readOneRange(start, len, signal, (received) => {
            receivedByPart[index] = received;
            const sum = receivedByPart.reduce((acc, value) => acc + value, 0);
            onProgress?.(sum, length);
          }),
        ),
      );
      const out = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    }
    return this.#readOneRange(offset, length, signal, onProgress);
  }

  async #fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const signal = init.signal ?? undefined;
    let delay = RETRY_BASE_MS;
    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
      const response = await fetch(url, init);
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_FETCH_ATTEMPTS) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 4000);
        continue;
      }
      return response;
    }
    throw new Error(`fetchWithRetry exhausted for ${url}`);
  }

  async #readOneRange(
    offset: number,
    length: number,
    signal?: AbortSignal,
    onProgress?: HttpReadProgress,
  ): Promise<Uint8Array> {
    const end = offset + length - 1;
    const response = await this.#fetchWithRetry(this._url, {
      headers: { Range: `bytes=${offset}-${end}` },
      signal,
    });

    if (!response.ok) {
      if (response.status === 416) {
        return new Uint8Array(0);
      }
      throw new Error(
        `Failed to read range ${offset}-${end} from ${this._url}: ${response.status} ${response.statusText}`,
      );
    }

    const headerLen = Number(response.headers.get('content-length') ?? '');
    const expected =
      Number.isFinite(headerLen) && headerLen > 0 ? headerLen : length;
    const buf = await this.#readResponseBody(response, expected, onProgress);

    if (response.status === 206) {
      if (buf.byteLength === length) {
        return buf;
      }
      if (buf.byteLength > length) {
        return buf.subarray(0, length);
      }
      throw new Error(`Short read: expected ${length} bytes, got ${buf.byteLength}`);
    }

    if (buf.byteLength === length) {
      return buf;
    }
    if (buf.byteLength > length && buf.byteLength >= offset + length) {
      return buf.subarray(offset, offset + length);
    }
    if (buf.byteLength > length) {
      return buf.subarray(0, length);
    }
    throw new Error(`Unexpected response length ${buf.byteLength} for range length ${length}`);
  }

  async #readResponseBody(
    response: Response,
    expected: number,
    onProgress?: HttpReadProgress,
  ): Promise<Uint8Array> {
    if (!response.body) {
      const buf = new Uint8Array(await response.arrayBuffer());
      onProgress?.(buf.byteLength, expected > 0 ? expected : buf.byteLength);
      return buf;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.(received, expected > 0 ? expected : received);
      }
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}
