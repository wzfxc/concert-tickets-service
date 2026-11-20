/** Every service/worker/job reads time through a Clock so tests can shift it (spec: time is faked in tests). */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** System time plus a mutable offset (ms). */
export class OffsetClock implements Clock {
  constructor(private offsetMs = 0) {}
  setOffset(ms: number): void {
    this.offsetMs = ms;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  now(): Date {
    return new Date(new Date().getTime() + this.offsetMs);
  }
}
