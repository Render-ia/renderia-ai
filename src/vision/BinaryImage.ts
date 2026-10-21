import sharp from 'sharp';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

/**
 * Black-and-white version of a floor plan: 1 = ink (walls, lines, text),
 * 0 = paper. Morphology operations use an integral image, so each one runs
 * in linear time whatever the window size.
 */
export class BinaryImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array,
  ) {}

  /**
   * Decodes an image (PNG, JPG, WEBP or SVG), reduces it so its longest side
   * is at most `maxSide`, and separates ink from paper with Otsu's threshold.
   */
  static async fromBuffer(buffer: Buffer, maxSide: number): Promise<{ image: BinaryImage; factor: number; threshold: number }> {
    const metadata = await sharp(buffer).metadata();
    const naturalWidth = metadata.width ?? 0;
    const naturalHeight = metadata.height ?? 0;
    const longest = Math.max(naturalWidth, naturalHeight);
    if (!longest) throw new Error('El plano no tiene un tamaño válido.');

    const factor = Math.min(1, maxSide / longest);
    const width = Math.max(1, Math.round(naturalWidth * factor));
    const height = Math.max(1, Math.round(naturalHeight * factor));

    // Transparent areas become white paper, like drawing the plan on a white canvas.
    const pixels = await sharp(buffer)
      .flatten({ background: '#ffffff' })
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();
    const channels = pixels.length / (width * height);

    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) {
      const p = i * channels;
      gray[i] =
        channels >= 3
          ? Math.round(0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2])
          : pixels[p];
    }

    const threshold = BinaryImage.otsu(gray);
    const data = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) data[i] = gray[i] < threshold ? 1 : 0;

    return { image: new BinaryImage(width, height, data), factor, threshold };
  }

  /** Otsu's method: the gray level that best splits ink from paper. */
  static otsu(gray: Uint8Array): number {
    const histogram = new Array<number>(256).fill(0);
    for (const value of gray) histogram[value]++;

    const total = gray.length;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * histogram[i];

    let sumBackground = 0;
    let weightBackground = 0;
    let best = 0;
    let threshold = 128;
    for (let t = 0; t < 256; t++) {
      weightBackground += histogram[t];
      if (weightBackground === 0) continue;
      const weightForeground = total - weightBackground;
      if (weightForeground === 0) break;
      sumBackground += t * histogram[t];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sumAll - sumBackground) / weightForeground;
      const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
      if (between > best) {
        best = between;
        threshold = t + 1;
      }
    }
    // Plans are mostly paper: never treat light grays as ink.
    return Math.min(threshold, 200);
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  inkRatio(): number {
    let ink = 0;
    for (const value of this.data) ink += value;
    return ink / this.data.length;
  }

  /** Keeps a pixel only if the whole (2r+1)² square around it is ink. */
  eroded(radius: number): BinaryImage {
    return this.window(radius, (sum, area) => sum === area);
  }

  /** Marks a pixel if any pixel of the (2r+1)² square around it is ink. */
  dilated(radius: number): BinaryImage {
    return this.window(radius, (sum) => sum > 0);
  }

  /** Erosion followed by dilation: removes strokes thinner than 2r+1 px. */
  opened(radius: number): BinaryImage {
    return radius <= 0 ? this : this.eroded(radius).dilated(radius);
  }

  /** Bounding boxes of the 4-connected groups of ink pixels. */
  components(): Box[] {
    const { width, height, data } = this;
    const seen = new Uint8Array(data.length);
    const stack: number[] = [];
    const boxes: Box[] = [];

    for (let start = 0; start < data.length; start++) {
      if (!data[start] || seen[start]) continue;
      const box: Box = { minX: width, minY: height, maxX: 0, maxY: 0, area: 0 };
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const index = stack.pop()!;
        const x = index % width;
        const y = (index - x) / width;
        box.area++;
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && data[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      boxes.push(box);
    }
    return boxes;
  }

  /** Applies a square window rule using a summed-area table. */
  private window(radius: number, keep: (sum: number, area: number) => boolean): BinaryImage {
    const { width, height, data } = this;
    const stride = width + 1;
    const integral = new Int32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += data[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }

    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height, y + radius + 1);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width, x + radius + 1);
        const sum =
          integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
        out[y * width + x] = keep(sum, (x1 - x0) * (y1 - y0)) ? 1 : 0;
      }
    }
    return new BinaryImage(width, height, out);
  }
}
