import type { ColumnBlob } from './ColumnDetector.ts';
import type { Orientation, WallSegment } from './WallDetector.ts';

export interface Opening {
  orientation: Orientation;
  line: number;
  start: number;
  end: number;
  thickness: number;
  exterior: boolean;
  kind: 'door' | 'window';
}

export interface Beam {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Outer rectangle of all walls, in pixels. */
export function wallBounds(walls: WallSegment[]): Bounds | null {
  if (walls.length === 0) return null;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const wall of walls) {
    const half = wall.thickness / 2;
    const [x0, x1, y0, y1] =
      wall.orientation === 'horizontal'
        ? [wall.start, wall.end, wall.line - half, wall.line + half]
        : [wall.line - half, wall.line + half, wall.start, wall.end];
    bounds.minX = Math.min(bounds.minX, x0);
    bounds.maxX = Math.max(bounds.maxX, x1);
    bounds.minY = Math.min(bounds.minY, y0);
    bounds.maxY = Math.max(bounds.maxY, y1);
  }
  return bounds;
}

/**
 * Doors and windows are the gaps between two pieces of the same wall line.
 * Gaps on the outer walls that are at least `windowMinPx` long are windows;
 * the rest are doors.
 */
export function findOpenings(
  walls: WallSegment[],
  bounds: Bounds,
  minGapPx: number,
  maxGapPx: number,
  windowMinPx: number,
): Opening[] {
  const openings: Opening[] = [];

  for (const orientation of ['horizontal', 'vertical'] as const) {
    const group = walls.filter((w) => w.orientation === orientation).sort((a, b) => a.line - b.line || a.start - b.start);

    for (let i = 0; i < group.length; i++) {
      const current = group[i];
      // Nearest piece after this one on the same line.
      let next: WallSegment | null = null;
      for (const other of group) {
        const sameLine = Math.abs(other.line - current.line) <= Math.max(current.thickness, other.thickness) * 0.6;
        if (other !== current && sameLine && other.start >= current.end && (!next || other.start < next.start)) {
          next = other;
        }
      }
      if (!next) continue;

      const gap = next.start - current.end;
      if (gap < minGapPx || gap > maxGapPx) continue;

      const thickness = Math.max(current.thickness, next.thickness);
      const [low, high] = orientation === 'horizontal' ? [bounds.minY, bounds.maxY] : [bounds.minX, bounds.maxX];
      const exterior = Math.abs(current.line - low) <= thickness * 2 || Math.abs(current.line - high) <= thickness * 2;

      openings.push({
        orientation,
        line: (current.line + next.line) / 2,
        start: current.end,
        end: next.start,
        thickness,
        exterior,
        kind: exterior && gap >= windowMinPx ? 'window' : 'door',
      });
    }
  }
  return openings;
}

/** Share of the stretch [from, to] on `line` that is covered by walls. */
function coverage(walls: WallSegment[], orientation: Orientation, line: number, from: number, to: number, tolerance: number): number {
  let covered = 0;
  for (const wall of walls) {
    if (wall.orientation !== orientation || Math.abs(wall.line - line) > tolerance) continue;
    covered += Math.max(0, Math.min(to, wall.end) - Math.max(from, wall.start));
  }
  return to > from ? covered / (to - from) : 0;
}

/**
 * Beams join two consecutive columns that sit on the same wall line: the wall
 * between them is what the beam carries.
 */
export function inferBeams(columns: ColumnBlob[], walls: WallSegment[], wallThickness: number): Beam[] {
  const beams: Beam[] = [];

  const link = (orientation: Orientation) => {
    const axis = (c: ColumnBlob) => (orientation === 'horizontal' ? c.centerX : c.centerY);
    const cross = (c: ColumnBlob) => (orientation === 'horizontal' ? c.centerY : c.centerX);

    for (const a of columns) {
      const candidates = columns
        .filter((b) => b !== a && axis(b) > axis(a))
        .filter((b) => Math.abs(cross(b) - cross(a)) <= Math.min(a.sizeX, a.sizeY, b.sizeX, b.sizeY) / 2)
        .sort((x, y) => axis(x) - axis(y));
      const b = candidates[0];
      if (!b) continue;

      const line = (cross(a) + cross(b)) / 2;
      if (coverage(walls, orientation, line, axis(a), axis(b), wallThickness) >= 0.6) {
        beams.push({ fromX: a.centerX, fromY: a.centerY, toX: b.centerX, toY: b.centerY });
      }
    }
  };

  link('horizontal');
  link('vertical');
  return beams;
}
