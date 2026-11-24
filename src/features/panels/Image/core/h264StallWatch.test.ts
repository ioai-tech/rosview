import { describe, expect, it } from 'vitest';
import { H264StallWatch } from './h264StallWatch';

const LIMIT = 4000;

describe('H264StallWatch', () => {
  it('reports once after 4 s of playing without progress', () => {
    const watch = new H264StallWatch();
    watch.setPlaying(true, 0);
    watch.arm(0);
    expect(watch.shouldReport(3999, LIMIT)).toBe(false);
    expect(watch.shouldReport(4000, LIMIT)).toBe(true);
    expect(watch.shouldReport(5000, LIMIT)).toBe(false);
    // Progress clears the report; a new stall reports again.
    watch.noteProgress(5000);
    expect(watch.shouldReport(9000, LIMIT)).toBe(true);
  });

  it('never reports while paused', () => {
    const watch = new H264StallWatch();
    watch.arm(0);
    expect(watch.shouldReport(60_000, LIMIT)).toBe(false);
  });

  it('does not count paused time: play after a long pause is not a stall', () => {
    const watch = new H264StallWatch();
    watch.setPlaying(true, 0);
    watch.arm(0);
    watch.noteProgress(1000);
    watch.setPlaying(false, 1000);
    // Paused for 10 s, then play: the first frame needs a moment, which is not a stall.
    watch.setPlaying(true, 11_000);
    expect(watch.shouldReport(11_050, LIMIT)).toBe(false);
    expect(watch.shouldReport(14_999, LIMIT)).toBe(false);
    // Still nothing 4 s of playing later: that is a stall.
    expect(watch.shouldReport(15_000, LIMIT)).toBe(true);
  });

  it('keeps the playing time spent without progress before the pause', () => {
    const watch = new H264StallWatch();
    watch.setPlaying(true, 0);
    watch.arm(0);
    watch.setPlaying(false, 3000); // 3 s played without a frame
    watch.setPlaying(true, 20_000);
    expect(watch.shouldReport(20_999, LIMIT)).toBe(false);
    expect(watch.shouldReport(21_000, LIMIT)).toBe(true);
  });

  it('ignores repeated transport messages and a paused repair', () => {
    const watch = new H264StallWatch();
    watch.arm(0);
    watch.setPlaying(false, 100);
    watch.noteProgress(500); // a paused seek decoded its frame
    watch.setPlaying(false, 2000);
    watch.setPlaying(true, 30_000);
    watch.setPlaying(true, 31_000);
    expect(watch.shouldReport(33_999, LIMIT)).toBe(false);
    expect(watch.shouldReport(34_000, LIMIT)).toBe(true);
  });

  it('starts over after a reset', () => {
    const watch = new H264StallWatch();
    watch.setPlaying(true, 0);
    watch.arm(0);
    watch.reset();
    expect(watch.shouldReport(10_000, LIMIT)).toBe(false);
    watch.arm(10_000);
    expect(watch.shouldReport(14_000, LIMIT)).toBe(true);
  });
});
