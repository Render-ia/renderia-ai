import type { BinaryImage } from './BinaryImage.ts';

/**
 * Estimates the usual wall thickness in pixels: the most common length of
 * the ink runs measured across walls (vertical runs for horizontal walls and
 * horizontal runs for vertical walls). Thin strokes (text, dimension lines)
 * and very long runs (the walls themselves, lengthwise) are ignored.
 */
export function estimateWallThickness(image: BinaryImage): number {
  const { width, height } = image;
  const maxRun = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  const counts = new Array<number>(maxRun + 1).fill(0);

  const record = (length: number) => {
    if (length >= 2 && length <= maxRun) counts[length] += length >= 3 ? 1 : 0.35;
  };

  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      if (image.get(x, y)) run++;
      else if (run) {
        record(run);
        run = 0;
      }
    }
    record(run);
  }

  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      if (image.get(x, y)) run++;
      else if (run) {
        record(run);
        run = 0;
      }
    }
    record(run);
  }

  // Smooth neighbouring lengths (antialiasing makes 8, 9 and 10 the same wall).
  let best = 3;
  let bestScore = -1;
  for (let length = 2; length <= maxRun; length++) {
    const score = counts[length] + 0.5 * ((counts[length - 1] ?? 0) + (counts[length + 1] ?? 0));
    if (score > bestScore) {
      bestScore = score;
      best = length;
    }
  }
  return best;
}
