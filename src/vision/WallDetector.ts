import type { BinaryImage } from './BinaryImage.ts';

export type Orientation = 'horizontal' | 'vertical';

/** Straight wall piece in pixels. `line` is the center line (y for horizontal walls, x for vertical). */
export interface WallSegment {
  orientation: Orientation;
  line: number;
  start: number;
  end: number;
  thickness: number;
  /** Variation of the run lengths inside the band (0 = perfectly straight). */
  irregularity: number;
}

interface Run {
  start: number;
  end: number;
}

interface Band {
  first: number;
  last: number;
  runs: Run[];
}

/**
 * Finds horizontal and vertical walls as "bands": groups of consecutive rows
 * (or columns) that contain a long ink run at about the same position.
 */
export class WallDetector {
  constructor(
    private readonly image: BinaryImage,
    private readonly wallThickness: number,
    private readonly minLength: number,
  ) {}

  detect(): WallSegment[] {
    return [...this.scan('horizontal'), ...this.scan('vertical')];
  }

  private scan(orientation: Orientation): WallSegment[] {
    const { width, height } = this.image;
    const lines = orientation === 'horizontal' ? height : width;
    const length = orientation === 'horizontal' ? width : height;
    const pixel =
      orientation === 'horizontal'
        ? (line: number, pos: number) => this.image.get(pos, line)
        : (line: number, pos: number) => this.image.get(line, pos);

    const closed: Band[] = [];
    let active: Band[] = [];

    for (let line = 0; line < lines; line++) {
      const runs = this.runsOf(line, length, pixel);
      const next: Band[] = [];
      const taken = new Set<Band>();

      for (const run of runs) {
        let match: Band | null = null;
        let bestOverlap = 0;
        for (const band of active) {
          if (taken.has(band)) continue;
          const previous = band.runs[band.runs.length - 1];
          const overlap = Math.min(run.end, previous.end) - Math.max(run.start, previous.start);
          const shorter = Math.min(run.end - run.start, previous.end - previous.start);
          if (overlap > 0.6 * shorter && overlap > bestOverlap) {
            bestOverlap = overlap;
            match = band;
          }
        }
        if (match) {
          match.runs.push(run);
          match.last = line;
          taken.add(match);
          next.push(match);
        } else {
          next.push({ first: line, last: line, runs: [run] });
        }
      }

      for (const band of active) if (!taken.has(band)) closed.push(band);
      active = next;
    }
    closed.push(...active);

    return closed
      .map((band) => this.toSegment(band, orientation))
      .filter((segment): segment is WallSegment => segment !== null);
  }

  private runsOf(line: number, length: number, pixel: (line: number, pos: number) => number): Run[] {
    const runs: Run[] = [];
    let start = -1;
    for (let pos = 0; pos <= length; pos++) {
      const ink = pos < length && pixel(line, pos) === 1;
      if (ink && start < 0) start = pos;
      if (!ink && start >= 0) {
        if (pos - start >= this.minLength) runs.push({ start, end: pos });
        start = -1;
      }
    }
    return runs;
  }

  /** Keeps bands as thick as a wall; thinner ones are lines, thicker ones are fills. */
  private toSegment(band: Band, orientation: Orientation): WallSegment | null {
    const thickness = band.last - band.first + 1;
    if (thickness < Math.max(2, this.wallThickness * 0.5) || thickness > this.wallThickness * 2.2) {
      return null;
    }
    const starts = band.runs.map((r) => r.start).sort((a, b) => a - b);
    const ends = band.runs.map((r) => r.end).sort((a, b) => a - b);
    const start = starts[Math.floor(starts.length / 2)];
    const end = ends[Math.floor(ends.length / 2)];
    if (end - start < this.minLength) return null;

    const lengths = band.runs.map((r) => r.end - r.start);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const deviation = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);

    return {
      orientation,
      line: (band.first + band.last + 1) / 2,
      start,
      end,
      thickness,
      irregularity: mean > 0 ? deviation / mean : 1,
    };
  }
}
