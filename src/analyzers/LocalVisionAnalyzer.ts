import { metersPerPixel } from '../scale.ts';
import { BinaryImage } from '../vision/BinaryImage.ts';
import { ColumnDetector } from '../vision/ColumnDetector.ts';
import { findOpenings, inferBeams, wallBounds } from '../vision/StructureInference.ts';
import { estimateWallThickness } from '../vision/StrokeWidth.ts';
import { WallDetector } from '../vision/WallDetector.ts';
import type { AnalysisInput, AnalysisOutput, DetectedElement, PlanAnalyzer } from './PlanAnalyzer.ts';

/** Longest side used for the analysis; bigger plans are reduced first. */
const WORK_SIDE = 1400;

const WALL_HEIGHT = 2.5;
const COLUMN_HEIGHT = 2.8;
const DOOR_HEIGHT = 2.1;
const WINDOW_HEIGHT = 1.2;
const BEAM_WIDTH = 0.25;
const BEAM_DEPTH = 0.35;
const SLAB_THICKNESS = 0.12;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Computer-vision model ("local-vision" in ai_models). It reads the drawing the
 * way a person would: thick straight strokes are walls, solid squares are
 * columns, gaps in a wall are doors or windows, and columns joined by a wall
 * carry a beam.
 */
export class LocalVisionAnalyzer implements PlanAnalyzer {
  readonly provider = 'local-vision';
  readonly name = 'Detector de visión local';

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const { image: raw, factor, threshold } = await BinaryImage.fromBuffer(input.image, WORK_SIDE);
    if (raw.inkRatio() < 0.002) {
      throw new Error('El plano parece estar en blanco. Revisa que la imagen tenga el dibujo.');
    }
    if (raw.inkRatio() > 0.6) {
      throw new Error('La imagen tiene demasiado fondo oscuro. Sube un plano con fondo claro.');
    }

    // Meters per pixel of the reduced image.
    const mpp = metersPerPixel(input.scale) / factor;
    const toM = (px: number) => round(px * mpp);

    const wallPx = estimateWallThickness(raw);
    const openRadius = wallPx >= 4 ? Math.max(1, Math.floor(wallPx / 4)) : 0;
    const clean = raw.opened(openRadius);

    const minLength = Math.max(wallPx * 3, Math.round(0.35 / mpp));
    const walls = new WallDetector(clean, wallPx, minLength).detect();
    if (walls.length === 0) {
      throw new Error('No se encontraron muros. Prueba con un plano más nítido o revisa la escala.');
    }
    const bounds = wallBounds(walls)!;

    const columns = new ColumnDetector(clean, wallPx).detect();

    const openings = findOpenings(walls, bounds, 0.55 / mpp, 2.6 / mpp, 1.1 / mpp);
    const beams = inferBeams(columns, walls, wallPx);

    const elements: DetectedElement[] = [];

    for (const wall of walls) {
      const lengthM = (wall.end - wall.start) * mpp;
      const confidence = clamp(0.55 + 0.4 * Math.min(1, lengthM / 4) - wall.irregularity, 0.35, 0.98);
      const horizontal = wall.orientation === 'horizontal';
      elements.push({
        type: 'Muro',
        material: 'Ladrillo',
        startX: toM(horizontal ? wall.start : wall.line),
        startY: toM(horizontal ? wall.line : wall.start),
        endX: toM(horizontal ? wall.end : wall.line),
        endY: toM(horizontal ? wall.line : wall.end),
        width: null,
        height: WALL_HEIGHT,
        thickness: toM(wall.thickness),
        confidence: round(confidence, 4),
      });
    }

    for (const column of columns) {
      elements.push({
        type: 'Columna',
        material: 'Concreto reforzado',
        startX: toM(column.centerX),
        startY: toM(column.centerY),
        endX: null,
        endY: null,
        width: toM(column.sizeX),
        height: COLUMN_HEIGHT,
        thickness: toM(column.sizeY),
        confidence: round(clamp(0.5 + 0.45 * column.fill, 0.4, 0.97), 4),
      });
    }

    for (const opening of openings) {
      const horizontal = opening.orientation === 'horizontal';
      const isWindow = opening.kind === 'window';
      elements.push({
        type: isWindow ? 'Ventana' : 'Puerta',
        material: isWindow ? null : 'Madera',
        startX: toM(horizontal ? opening.start : opening.line),
        startY: toM(horizontal ? opening.line : opening.start),
        endX: toM(horizontal ? opening.end : opening.line),
        endY: toM(horizontal ? opening.line : opening.end),
        width: toM(opening.end - opening.start),
        height: isWindow ? WINDOW_HEIGHT : DOOR_HEIGHT,
        thickness: toM(opening.thickness),
        confidence: opening.exterior ? 0.72 : 0.8,
      });
    }

    for (const beam of beams) {
      elements.push({
        type: 'Viga',
        material: 'Concreto reforzado',
        startX: toM(beam.fromX),
        startY: toM(beam.fromY),
        endX: toM(beam.toX),
        endY: toM(beam.toY),
        width: BEAM_WIDTH,
        height: BEAM_DEPTH,
        thickness: BEAM_WIDTH,
        confidence: 0.75,
      });
    }

    elements.push({
      type: 'Losa',
      material: 'Concreto reforzado',
      startX: toM(bounds.minX),
      startY: toM(bounds.minY),
      endX: toM(bounds.maxX),
      endY: toM(bounds.maxY),
      width: null,
      height: null,
      thickness: SLAB_THICKNESS,
      confidence: 0.9,
    });

    return {
      elements,
      summary: {
        analyzer: this.name,
        modelIdentifier: input.modelIdentifier,
        imageSize: { width: raw.width, height: raw.height, reduction: round(factor, 4) },
        inkThreshold: threshold,
        metersPerPixel: round(mpp, 5),
        wallThicknessPx: wallPx,
        wallThicknessM: toM(wallPx),
        buildingSizeM: { width: toM(bounds.maxX - bounds.minX), depth: toM(bounds.maxY - bounds.minY) },
        counts: {
          walls: walls.length,
          columns: columns.length,
          doors: openings.filter((o) => o.kind === 'door').length,
          windows: openings.filter((o) => o.kind === 'window').length,
          beams: beams.length,
        },
      },
    };
  }
}
