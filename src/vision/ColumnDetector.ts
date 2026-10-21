import type { BinaryImage } from './BinaryImage.ts';

/** Column found in pixels: its center and the size of each side. */
export interface ColumnBlob {
  centerX: number;
  centerY: number;
  sizeX: number;
  sizeY: number;
  /** Share of the bounding box that is solid ink (1 = fully filled square). */
  fill: number;
}

/**
 * Columns are drawn as filled squares thicker than the walls. Eroding the
 * plan by a bit more than half the wall thickness erases every wall and
 * leaves only those thicker blobs.
 */
export class ColumnDetector {
  constructor(
    private readonly image: BinaryImage,
    private readonly wallThickness: number,
  ) {}

  detect(): ColumnBlob[] {
    const radius = Math.ceil(this.wallThickness / 2) + 1;
    const cores = this.image.eroded(radius).components();
    const minSide = this.wallThickness * 1.3;
    const maxSide = this.wallThickness * 6;

    return cores
      .map((core) => {
        const minX = Math.max(0, core.minX - radius);
        const minY = Math.max(0, core.minY - radius);
        const maxX = Math.min(this.image.width - 1, core.maxX + radius);
        const maxY = Math.min(this.image.height - 1, core.maxY + radius);
        const sizeX = maxX - minX + 1;
        const sizeY = maxY - minY + 1;
        return {
          centerX: (minX + maxX + 1) / 2,
          centerY: (minY + maxY + 1) / 2,
          sizeX,
          sizeY,
          fill: this.fillRatio(minX, minY, maxX, maxY),
        };
      })
      .filter((blob) => {
        const aspect = blob.sizeX / blob.sizeY;
        return (
          blob.sizeX >= minSide &&
          blob.sizeY >= minSide &&
          blob.sizeX <= maxSide &&
          blob.sizeY <= maxSide &&
          aspect >= 0.5 &&
          aspect <= 2 &&
          blob.fill >= 0.75
        );
      });
  }

  private fillRatio(minX: number, minY: number, maxX: number, maxY: number): number {
    let ink = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) ink += this.image.get(x, y);
    }
    return ink / ((maxX - minX + 1) * (maxY - minY + 1));
  }
}
