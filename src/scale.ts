/**
 * Resolution assumed for scanned plans. A plan drawn at 1:100 and scanned at
 * 150 dpi has 1 px = 0.1693 mm on paper = 16.93 mm in reality.
 */
export const SCAN_DPI = 150;

const METERS_PER_INCH = 0.0254;

/** Reads the denominator of a scale written as "1:100". */
export function scaleDenominator(scale: string): number {
  const match = /^\s*1\s*:\s*(\d+(?:[.,]\d+)?)\s*$/.exec(scale);
  const value = match ? Number(match[1].replace(',', '.')) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`La escala "${scale}" no es válida. Escríbela como 1:100.`);
  }
  return value;
}

/** Real meters represented by one pixel of the stored image. */
export function metersPerPixel(scale: string): number {
  return (METERS_PER_INCH / SCAN_DPI) * scaleDenominator(scale);
}

/**
 * When an image is reduced by `factor`, each pixel covers more meters, which
 * is the same as a drawing at a larger scale denominator.
 */
export function adjustScale(scale: string, factor: number): string {
  if (factor === 1) return scale;
  return `1:${Math.round(scaleDenominator(scale) / factor)}`;
}
