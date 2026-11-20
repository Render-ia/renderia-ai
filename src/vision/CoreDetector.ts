import { BinaryImage, type Box } from './BinaryImage.ts';

/** Stair flight or elevator shaft found in the plan, in pixels. */
export interface CoreFeature {
  kind: 'stair' | 'elevator';
  centerX: number;
  centerY: number;
  /** Size along x and along y. */
  sizeX: number;
  sizeY: number;
  /** Stairs: the steps go up along x (true) or along y (false). */
  alongX: boolean;
}

/**
 * Finds what the walls don't show in the building core, using the thin
 * lines that the wall detector ignores:
 * - stairs: five or more parallel, evenly spaced treads of the same length;
 * - elevators: a square-ish box crossed by an X from corner to corner.
 */
export class CoreDetector {
  private readonly thin: BinaryImage;

  constructor(
    lines: BinaryImage,
    clean: BinaryImage,
    private readonly metersPerPixel: number,
  ) {
    // Thin lines = line ink away from walls and columns (their soft edges are left out too).
    const solid = clean.dilated(2);
    const data = new Uint8Array(lines.data.length);
    for (let i = 0; i < data.length; i++) data[i] = lines.data[i] && !solid.data[i] ? 1 : 0;
    this.thin = new BinaryImage(lines.width, lines.height, data);
  }

  detect(): CoreFeature[] {
    const boxes = this.thin.components();
    return [...this.stairs(boxes), ...this.elevators(boxes)];
  }

  private stairs(boxes: Box[]): CoreFeature[] {
    const px = (m: number) => m / this.metersPerPixel;
    const features: CoreFeature[] = [];
    for (const alongX of [true, false]) {
      // A tread across a flight that goes along x is a short vertical line, and vice versa.
      const treads = boxes.filter((b) => {
        const across = alongX ? b.maxY - b.minY + 1 : b.maxX - b.minX + 1;
        const thickness = alongX ? b.maxX - b.minX + 1 : b.maxY - b.minY + 1;
        return thickness <= 4 && across >= px(0.6) && across <= px(2.2);
      });
      const position = (b: Box) => (alongX ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2);
      const start = (b: Box) => (alongX ? b.minY : b.minX);
      const end = (b: Box) => (alongX ? b.maxY : b.maxX);
      treads.sort((a, b) => start(a) - start(b) || position(a) - position(b));

      const used = new Set<Box>();
      for (const first of treads) {
        if (used.has(first)) continue;
        // Treads that span the same stretch, ordered along the flight.
        const row = treads
          .filter((t) => !used.has(t) && Math.abs(start(t) - start(first)) <= 4 && Math.abs(end(t) - end(first)) <= 4)
          .sort((a, b) => position(a) - position(b));
        const flight = evenlySpaced(row, position, px(0.15), px(0.45));
        if (flight.length < 5) continue;
        flight.forEach((t) => used.add(t));
        const minPos = position(flight[0]);
        const maxPos = position(flight[flight.length - 1]);
        const step = Math.min(...flight.slice(1).map((t, i) => position(t) - position(flight[i])));
        const from = minPos - step / 2;
        const to = maxPos + step / 2;
        const lo = Math.min(...flight.map(start));
        const hi = Math.max(...flight.map(end));
        features.push({
          kind: 'stair',
          centerX: alongX ? (from + to) / 2 : (lo + hi) / 2,
          centerY: alongX ? (lo + hi) / 2 : (from + to) / 2,
          sizeX: alongX ? to - from : hi - lo,
          sizeY: alongX ? hi - lo : to - from,
          alongX,
        });
      }
    }
    return mergeStacked(features);
  }

  private elevators(boxes: Box[]): CoreFeature[] {
    const px = (m: number) => m / this.metersPerPixel;
    // Reducing the image breaks thin diagonals into pieces: join the pieces that almost touch.
    return joinNear(boxes.filter((b) => b.maxX - b.minX >= 3 && b.maxY - b.minY >= 3), 6)
      .filter((b) => {
        const w = b.maxX - b.minX + 1;
        const h = b.maxY - b.minY + 1;
        return w >= px(0.8) && h >= px(0.8) && w <= px(3.5) && h <= px(3.5) && w / h > 0.4 && w / h < 2.5;
      })
      .filter((b) => this.onLine(b.minX, b.minY, b.maxX, b.maxY) >= 0.85 && this.onLine(b.maxX, b.minY, b.minX, b.maxY) >= 0.85)
      .map((b) => ({
        kind: 'elevator' as const,
        centerX: (b.minX + b.maxX) / 2,
        centerY: (b.minY + b.maxY) / 2,
        sizeX: b.maxX - b.minX + 1,
        sizeY: b.maxY - b.minY + 1,
        alongX: true,
      }));
  }

  /** Share of the points between two corners that have a thin line nearby. */
  private onLine(x0: number, y0: number, x1: number, y1: number): number {
    const samples = 40;
    let hits = 0;
    for (let i = 4; i <= samples - 4; i++) {
      const t = i / samples;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      let found = false;
      for (let dy = -2; dy <= 2 && !found; dy++) {
        for (let dx = -2; dx <= 2 && !found; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < this.thin.width && ny < this.thin.height && this.thin.get(nx, ny)) found = true;
        }
      }
      if (found) hits++;
    }
    return hits / (samples - 7);
  }
}

/** Longest run of boxes whose gaps are within [min, max] and about the same. */
function evenlySpaced(row: Box[], position: (b: Box) => number, min: number, max: number): Box[] {
  let best: Box[] = [];
  let current: Box[] = row.length ? [row[0]] : [];
  let step = 0;
  for (let i = 1; i < row.length; i++) {
    const gap = position(row[i]) - position(row[i - 1]);
    const inRange = gap >= min && gap <= max;
    const tolerance = Math.max(3, step * 0.25);
    // A tread hidden under a label leaves a gap of two or three steps: keep going.
    const skipped = step > 0 && [2, 3].some((k) => Math.abs(gap - k * step) <= tolerance * k);
    if (inRange && (step === 0 || Math.abs(gap - step) <= tolerance)) {
      if (step === 0) step = gap;
      current.push(row[i]);
    } else if (skipped) {
      current.push(row[i]);
    } else {
      if (current.length > best.length) best = current;
      current = inRange ? [row[i - 1], row[i]] : [row[i]];
      step = inRange ? gap : 0;
    }
  }
  return current.length > best.length ? current : best;
}

/** Boxes whose edges are at most `gap` pixels apart, joined into one box each. */
function joinNear(boxes: Box[], gap: number): Box[] {
  const joined = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < joined.length && !changed; i++) {
      for (let j = i + 1; j < joined.length; j++) {
        const a = joined[i];
        const b = joined[j];
        if (a.minX - gap > b.maxX || b.minX - gap > a.maxX || a.minY - gap > b.maxY || b.minY - gap > a.maxY) continue;
        joined[i] = { ...a, minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
        joined.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return joined;
}

/** Two flights side by side (a U-shaped stair) become one stair. */
function mergeStacked(stairs: CoreFeature[]): CoreFeature[] {
  const result: CoreFeature[] = [];
  for (const stair of stairs) {
    const twin = result.find(
      (s) =>
        s.alongX === stair.alongX &&
        (stair.alongX
          ? Math.abs(s.centerX - stair.centerX) < s.sizeX * 0.3 && Math.abs(s.centerY - stair.centerY) < (s.sizeY + stair.sizeY) * 0.7
          : Math.abs(s.centerY - stair.centerY) < s.sizeY * 0.3 && Math.abs(s.centerX - stair.centerX) < (s.sizeX + stair.sizeX) * 0.7),
    );
    if (!twin) {
      result.push({ ...stair });
      continue;
    }
    const minX = Math.min(twin.centerX - twin.sizeX / 2, stair.centerX - stair.sizeX / 2);
    const maxX = Math.max(twin.centerX + twin.sizeX / 2, stair.centerX + stair.sizeX / 2);
    const minY = Math.min(twin.centerY - twin.sizeY / 2, stair.centerY - stair.sizeY / 2);
    const maxY = Math.max(twin.centerY + twin.sizeY / 2, stair.centerY + stair.sizeY / 2);
    Object.assign(twin, { centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, sizeX: maxX - minX, sizeY: maxY - minY });
  }
  return result;
}
