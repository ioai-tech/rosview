/**
 * Transfer-list selection for messages posted from source workers.
 *
 * `postMessage` throws a DataCloneError (surfaced by Comlink as "Unserializable
 * return value", dropping the whole batch) when the transfer list repeats a
 * buffer or names a detached one. Deserializers routinely return several typed
 * arrays that are zero-copy views into one message buffer (e.g. per-motor
 * `Float32Array` / `Uint32Array` fields), so the list must be curated, not
 * collected naively:
 *
 * - each buffer appears at most once;
 * - detached buffers are never listed (cloning a view on one fails regardless,
 *   so we must not create them);
 * - a buffer reachable from more than one message is not transferred, because
 *   detaching it would break the other message;
 * - a buffer is transferred only when its largest view covers most of it.
 *   Small multi-field messages are cheaper to clone, and transferring a large
 *   shared backing store for a tiny view would detach unrelated data.
 *
 * Anything not transferred is structured-cloned, which is always safe.
 */

/** Largest view must cover at least this share of its buffer for the buffer to be transferred. */
const MIN_VIEW_COVERAGE = 0.5;

/**
 * Buffers pinned by worker-side caches (e.g. decompressed MCAP chunks). They
 * must never be listed as transferables, because transferring detaches them and
 * corrupts subsequent cache hits.
 */
const pinnedBuffers = new WeakSet<ArrayBuffer>();

export function pinTransferableBuffer(buffer: ArrayBufferLike): void {
  if (buffer instanceof ArrayBuffer) {
    pinnedBuffers.add(buffer);
  }
}

interface BufferUsage {
  owner: number;
  sharedAcrossOwners: boolean;
  largestView: number;
}

function isDetached(buffer: ArrayBuffer): boolean {
  const flag = (buffer as ArrayBuffer & { detached?: boolean }).detached;
  return flag === true || (flag === undefined && buffer.byteLength === 0);
}

function recordBuffer(
  buffer: ArrayBuffer,
  viewBytes: number,
  owner: number,
  usage: Map<ArrayBuffer, BufferUsage>,
): void {
  const entry = usage.get(buffer);
  if (!entry) {
    usage.set(buffer, { owner, sharedAcrossOwners: false, largestView: viewBytes });
    return;
  }
  if (entry.owner !== owner) entry.sharedAcrossOwners = true;
  if (viewBytes > entry.largestView) entry.largestView = viewBytes;
}

function visitTransferables(
  value: unknown,
  owner: number,
  seen: WeakSet<object>,
  usage: Map<ArrayBuffer, BufferUsage>,
): void {
  if (!value) return;

  if (value instanceof ArrayBuffer) {
    recordBuffer(value, value.byteLength, owner, usage);
    return;
  }

  if (ArrayBuffer.isView(value)) {
    const viewBuffer = value.buffer;
    if (viewBuffer instanceof ArrayBuffer) {
      recordBuffer(viewBuffer, value.byteLength, owner, usage);
    }
    return;
  }

  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visitTransferables(item, owner, seen, usage);
    }
    return;
  }

  for (const item of Object.values(value as Record<string, unknown>)) {
    visitTransferables(item, owner, seen, usage);
  }
}

/**
 * Buffers that can be safely transferred along with `messages`. Each element of
 * `messages` is one owner: a buffer reachable from two of them is cloned instead.
 */
export function collectTransferables(messages: readonly unknown[]): Transferable[] {
  const usage = new Map<ArrayBuffer, BufferUsage>();
  messages.forEach((message, owner) => {
    // Per-owner `seen`: an object shared by two messages must count for both.
    visitTransferables(message, owner, new WeakSet<object>(), usage);
  });

  const out: Transferable[] = [];
  for (const [buffer, entry] of usage) {
    if (entry.sharedAcrossOwners || isDetached(buffer) || pinnedBuffers.has(buffer)) continue;
    if (entry.largestView < buffer.byteLength * MIN_VIEW_COVERAGE) continue;
    out.push(buffer);
  }
  return out;
}
