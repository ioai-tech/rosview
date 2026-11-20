import { describe, expect, it } from 'vitest';
import { BackgroundReadGate } from './backgroundReadGate';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BackgroundReadGate', () => {
  it('lets at most `slots` background reads run at once', async () => {
    const gate = new BackgroundReadGate(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    let third: (() => void) | undefined;
    void gate.acquire().then((release) => (third = release));
    await tick();
    expect(third).toBeUndefined();
    a!();
    await tick();
    expect(third).toBeDefined();
    b!();
    third!();
  });

  it('holds background reads while a foreground read runs, and lets them go when it ends', async () => {
    const gate = new BackgroundReadGate(2);
    const end = gate.beginForeground();
    let got: (() => void) | undefined;
    void gate.acquire().then((release) => (got = release));
    await tick();
    expect(got).toBeUndefined();
    end();
    end(); // ending twice is harmless
    await tick();
    expect(got).toBeDefined();
  });

  it('gives up waiting when the read is aborted', async () => {
    const gate = new BackgroundReadGate(1);
    const end = gate.beginForeground();
    const controller = new AbortController();
    const pending = gate.acquire(controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
    end();
    // The aborted wait took no slot.
    expect(await gate.acquire()).toBeDefined();
  });
});
