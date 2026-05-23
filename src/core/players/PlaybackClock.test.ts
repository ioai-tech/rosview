import { describe, expect, it } from 'vitest';

import { PlaybackClock } from './PlaybackClock';

describe('PlaybackClock', () => {
  it('advances from the play anchor at the active speed', () => {
    const clock = new PlaybackClock({ sec: 10, nsec: 0 });

    clock.play({ sec: 10, nsec: 0 }, 2, 1000);

    expect(clock.getTime(1250)).toEqual({ sec: 10, nsec: 500_000_000 });
  });

  it('freezes while suspended and resumes without catching up hidden wall time', () => {
    const clock = new PlaybackClock();

    clock.play({ sec: 0, nsec: 0 }, 1, 0);
    clock.suspend(1000);

    expect(clock.getTime(11_000)).toEqual({ sec: 1, nsec: 0 });

    clock.resume(11_000);

    expect(clock.getTime(11_500)).toEqual({ sec: 1, nsec: 500_000_000 });
  });

  it('changes speed without jumping the current playback time', () => {
    const clock = new PlaybackClock();

    clock.play({ sec: 0, nsec: 0 }, 1, 0);
    clock.setSpeed(4, 1000);

    expect(clock.getTime(1000)).toEqual({ sec: 1, nsec: 0 });
    expect(clock.getTime(1250)).toEqual({ sec: 2, nsec: 0 });
  });

  it('continues from a seek target', () => {
    const clock = new PlaybackClock();

    clock.play({ sec: 0, nsec: 0 }, 1, 0);
    clock.seek({ sec: 5, nsec: 250_000_000 }, 1000);

    expect(clock.getTime(1500)).toEqual({ sec: 5, nsec: 750_000_000 });
  });

  it('stops advancing after pause', () => {
    const clock = new PlaybackClock();

    clock.play({ sec: 0, nsec: 0 }, 1, 0);
    clock.pause(1000);

    expect(clock.getTime(5000)).toEqual({ sec: 1, nsec: 0 });
  });
});
