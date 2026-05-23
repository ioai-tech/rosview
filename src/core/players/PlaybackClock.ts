import type { Time } from '@/core/types/ros';
import { fromNano, toNano } from '@/shared/utils/time';

const NS_PER_MS = 1_000_000;

export class PlaybackClock {
  private anchorTimeNs: bigint;
  private anchorWallMs = 0;
  private speed = 1;
  private running = false;
  private suspended = false;

  constructor(initialTime: Time = { sec: 0, nsec: 0 }) {
    this.anchorTimeNs = toNano(initialTime);
  }

  getTime(nowMs: number): Time {
    return fromNano(this.timeNsAt(nowMs));
  }

  play(from: Time, speed: number, nowMs: number): void {
    this.anchorTimeNs = toNano(from);
    this.anchorWallMs = nowMs;
    this.speed = sanitizeSpeed(speed);
    this.running = true;
    this.suspended = false;
  }

  pause(nowMs: number): void {
    this.anchorTimeNs = this.timeNsAt(nowMs);
    this.anchorWallMs = nowMs;
    this.running = false;
    this.suspended = false;
  }

  seek(to: Time, nowMs: number): void {
    this.anchorTimeNs = toNano(to);
    this.anchorWallMs = nowMs;
  }

  setSpeed(speed: number, nowMs: number): void {
    this.anchorTimeNs = this.timeNsAt(nowMs);
    this.anchorWallMs = nowMs;
    this.speed = sanitizeSpeed(speed);
  }

  suspend(nowMs: number): void {
    if (!this.running || this.suspended) {
      return;
    }
    this.anchorTimeNs = this.timeNsAt(nowMs);
    this.anchorWallMs = nowMs;
    this.suspended = true;
  }

  resume(nowMs: number): void {
    if (!this.running || !this.suspended) {
      return;
    }
    this.anchorWallMs = nowMs;
    this.suspended = false;
  }

  private timeNsAt(nowMs: number): bigint {
    if (!this.running || this.suspended) {
      return this.anchorTimeNs;
    }
    const elapsedMs = Math.max(0, nowMs - this.anchorWallMs);
    return this.anchorTimeNs + BigInt(Math.round(elapsedMs * this.speed * NS_PER_MS));
  }
}

function sanitizeSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}
