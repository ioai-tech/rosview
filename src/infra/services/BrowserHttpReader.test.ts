import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserHttpReader } from './BrowserHttpReader';

describe('BrowserHttpReader streaming progress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports incremental progress while streaming a range', async () => {
    const part1 = new Uint8Array([1, 2, 3, 4]);
    const part2 = new Uint8Array([5, 6, 7, 8]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(part1);
              controller.enqueue(part2);
              controller.close();
            },
          }),
          {
            status: 206,
            headers: {
              'Content-Range': 'bytes 0-7/100',
              'Content-Length': '8',
            },
          },
        );
      }),
    );

    const reader = new BrowserHttpReader('https://example.com/file.mcap');
    const updates: Array<[number, number]> = [];
    const data = await reader.read(0, 8, undefined, (received, expected) => {
      updates.push([received, expected]);
    });

    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[updates.length - 1]).toEqual([8, 8]);
    expect(updates[0][0]).toBeLessThan(updates[updates.length - 1][0]);
  });
});
