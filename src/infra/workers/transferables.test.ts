import { describe, expect, it } from "vitest";
import { collectTransferables, pinTransferableBuffer } from "./transferables";

/** `structuredClone` enforces the same transfer-list rules as `postMessage`. */
function postLike(messages: unknown[]): unknown[] {
  return structuredClone(messages, { transfer: collectTransferables(messages) });
}

/** LowState-like message: many small typed-array fields viewing one message buffer. */
function multiViewMessage(): { buffer: ArrayBuffer; message: unknown } {
  const buffer = new ArrayBuffer(2280);
  const motor = (i: number) => ({ q: i, reserve: new Uint32Array(buffer, 64 + i * 8, 2) });
  return {
    buffer,
    message: {
      topic: "/record/robot/state",
      message: {
        imu_state: { rpy: new Float32Array(buffer, 4, 3), gyro: new Float32Array(buffer, 16, 3) },
        motor_state_serial: Array.from({ length: 31 }, (_, i) => motor(i)),
      },
    },
  };
}

describe("collectTransferables", () => {
  it("never lists a buffer twice", () => {
    const shared = new ArrayBuffer(16);
    const message = { a: new Uint8Array(shared, 0, 8), b: new Uint8Array(shared, 8, 8) };
    const list = collectTransferables([message]);
    expect(list).toEqual([shared]);
    expect(() => postLike([message])).not.toThrow();
  });

  it("clones small views of a larger message buffer instead of transferring it", () => {
    const { buffer, message } = multiViewMessage();
    expect(collectTransferables([message])).toEqual([]);
    const [copy] = postLike([message]) as [typeof message];
    expect(copy).toEqual(message);
    expect(buffer.byteLength).toBe(2280);
  });

  it("transfers a payload that covers its buffer (image data)", () => {
    const buffer = new ArrayBuffer(365_640);
    const message = { message: { encoding: "nv12", data: new Uint8Array(buffer, 72, 365_568) } };
    expect(collectTransferables([message])).toEqual([buffer]);
    postLike([message]);
    expect(buffer.byteLength).toBe(0);
  });

  it("does not transfer a buffer reachable from two messages in a batch", () => {
    const buffer = new ArrayBuffer(1024);
    const first = { data: new Uint8Array(buffer, 0, 1024) };
    const second = { data: new Uint8Array(buffer, 0, 1024) };
    expect(collectTransferables([first, second])).toEqual([]);
    expect(() => postLike([first, second])).not.toThrow();
    expect(buffer.byteLength).toBe(1024);
  });

  it("skips detached buffers", () => {
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    expect(collectTransferables([{ raw: buffer }])).toEqual([]);
  });

  it("batches of multi-view messages post without DataCloneError", () => {
    const batch = Array.from({ length: 50 }, () => multiViewMessage().message);
    expect(() => postLike(batch)).not.toThrow();
  });

  it("never transfers a pinned cache buffer", () => {
    const buffer = new ArrayBuffer(1024);
    pinTransferableBuffer(buffer);
    const message = { data: new Uint8Array(buffer) };
    expect(collectTransferables([message])).toEqual([]);
    postLike([message]);
    expect(buffer.byteLength).toBe(1024);
  });
});
