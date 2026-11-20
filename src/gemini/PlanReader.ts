import sharp from 'sharp';
import { assumption } from '../analyzers/assumptions.ts';
import type { AnalysisOutput, DetectedElement, ElementTypeName } from '../analyzers/PlanAnalyzer.ts';
import { metersPerPixel } from '../scale.ts';
import { GeminiClient, GeminiError } from './GeminiClient.ts';
import { PLAN_PROMPT, PLAN_RESPONSE_SCHEMA, PLAN_TYPES } from './planSchema.ts';

/** Longest side sent to Gemini. More pixels do not improve the reading and cost tokens. */
const SEND_SIDE = 2048;
const MAX_ELEMENTS = 400;

/**
 * Values the plan rarely says. They are configurable defaults, never facts:
 * every one is reported in summary.assumptions so the user confirms it.
 */
export const DEFAULTS = {
  wallHeight: 2.5,
  wallThickness: 0.15,
  columnHeight: 2.8,
  doorHeight: 2.1,
  windowHeight: 1.2,
  beamWidth: 0.25,
  beamDepth: 0.35,
  slabThickness: 0.12,
} as const;

const MATERIALS: Record<ElementTypeName, string | null> = {
  Muro: 'Ladrillo',
  Columna: 'Concreto reforzado',
  Viga: 'Concreto reforzado',
  Losa: 'Concreto reforzado',
  Puerta: 'Madera',
  Ventana: null,
  Escalera: 'Concreto reforzado',
};

interface RawBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
}

export interface GeminiPlanReading {
  legible: boolean;
  issues: string[];
  scaleText?: string | null;
  elements: (RawBox & { type: string })[];
  rooms: (RawBox & { name: string })[];
  dimensions: { text: string; meters?: number | null }[];
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Asks Gemini to read a plan image and converts the answer with deterministic
 * rules: it clamps coordinates, converts them to meters with the plan scale,
 * snaps nearly straight lines and fills unknown sizes with defaults that are
 * reported as assumptions. The model never decides a dimension on its own.
 */
export class GeminiPlanReader {
  constructor(private readonly client = new GeminiClient()) {}

  get configured(): boolean {
    return this.client.configured;
  }

  /** Raw interpretation of the plan, plus the size of the image it refers to. */
  async read(image: Buffer, model: string): Promise<{ reading: GeminiPlanReading; width: number; height: number }> {
    const metadata = await sharp(image).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) throw new Error('El plano no tiene un tamaño válido.');

    const png = await sharp(image)
      .flatten({ background: '#ffffff' })
      .resize(SEND_SIDE, SEND_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    const reading = await this.client.generateJson<GeminiPlanReading>({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: PLAN_PROMPT }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }],
        },
      ],
      schema: PLAN_RESPONSE_SCHEMA,
      temperature: 0.1,
    });
    return { reading, width, height };
  }

  /** Pure conversion from Gemini's answer to elements in meters. Exposed for tests. */
  static toOutput(
    reading: GeminiPlanReading,
    image: { width: number; height: number; scale: string; modelIdentifier: string; name: string },
  ): AnalysisOutput {
    const issues = Array.isArray(reading.issues) ? reading.issues.filter((i) => typeof i === 'string').slice(0, 10) : [];
    const hasContent = (Array.isArray(reading.elements) && reading.elements.length > 0) || (Array.isArray(reading.rooms) && reading.rooms.length > 0);
    // A doubtful "not legible" that still comes with elements or rooms is kept, with its issues as warnings.
    if (reading.legible === false && !hasContent) {
      throw new GeminiError(
        `Gemini no pudo interpretar el plano${issues.length ? `: ${issues.join('; ')}` : '.'} Sube una imagen más nítida o usa el detector local.`,
      );
    }

    const mpp = metersPerPixel(image.scale);
    const mx = (n: number) => round((clamp(n, 0, 1000) / 1000) * image.width * mpp);
    const my = (n: number) => round((clamp(n, 0, 1000) / 1000) * image.height * mpp);
    // Lines within 1.5% of horizontal or vertical are snapped: plans are orthogonal far more often than not.
    const snap = (a: number, b: number) => (Math.abs(a - b) <= 15 ? (a + b) / 2 : null);

    const elements: DetectedElement[] = [];
    const raw = Array.isArray(reading.elements) ? reading.elements : [];
    for (const item of raw.slice(0, MAX_ELEMENTS)) {
      const type = item?.type as ElementTypeName;
      if (!PLAN_TYPES.includes(type)) continue;
      if (![item.x1, item.y1, item.x2, item.y2].every(finite)) continue;
      const confidence = round(clamp(finite(item.confidence) ? item.confidence : 0.5, 0, 1), 4);
      let { x1, y1, x2, y2 } = item;

      if (type === 'Muro' || type === 'Viga' || type === 'Puerta' || type === 'Ventana') {
        const sy = snap(y1, y2);
        const sx = snap(x1, x2);
        if (sy !== null) y1 = y2 = sy;
        else if (sx !== null) x1 = x2 = sx;
        const length = Math.hypot(mx(x2) - mx(x1), my(y2) - my(y1));
        if (length < 0.2) continue;
        const base = { type, material: MATERIALS[type], startX: mx(x1), startY: my(y1), endX: mx(x2), endY: my(y2), confidence };
        if (type === 'Muro') {
          elements.push({ ...base, width: null, height: DEFAULTS.wallHeight, thickness: DEFAULTS.wallThickness });
        } else if (type === 'Viga') {
          elements.push({ ...base, width: DEFAULTS.beamWidth, height: DEFAULTS.beamDepth, thickness: DEFAULTS.beamWidth });
        } else {
          const isDoor = type === 'Puerta';
          elements.push({
            ...base,
            width: round(length),
            height: isDoor ? DEFAULTS.doorHeight : DEFAULTS.windowHeight,
            thickness: DEFAULTS.wallThickness,
          });
        }
        continue;
      }

      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      if (type === 'Columna') {
        const sizeX = Math.max(0.15, mx(right) - mx(left));
        const sizeY = Math.max(0.15, my(bottom) - my(top));
        if (sizeX > 1.5 || sizeY > 1.5) continue; // A 1.5 m "column" is a misreading.
        elements.push({
          type,
          material: MATERIALS.Columna,
          startX: round((mx(left) + mx(right)) / 2),
          startY: round((my(top) + my(bottom)) / 2),
          endX: null,
          endY: null,
          width: round(sizeX),
          height: DEFAULTS.columnHeight,
          thickness: round(sizeY),
          confidence,
        });
      } else {
        if (mx(right) - mx(left) < 0.3 || my(bottom) - my(top) < 0.3) continue;
        elements.push({
          type,
          material: MATERIALS[type],
          startX: mx(left),
          startY: my(top),
          endX: mx(right),
          endY: my(bottom),
          width: null,
          height: null,
          thickness: type === 'Losa' ? DEFAULTS.slabThickness : null,
          confidence,
        });
      }
    }

    if (!elements.some((e) => e.type === 'Muro')) {
      throw new GeminiError('Gemini no encontró muros en el plano. Revisa la imagen o prueba con el detector local.');
    }

    // Without a slab drawn, add one over the wall bounds so the 3D model has a floor, marked as an assumption.
    let slabAssumed = false;
    if (!elements.some((e) => e.type === 'Losa')) {
      const walls = elements.filter((e) => e.type === 'Muro');
      const xs = walls.flatMap((w) => [w.startX, w.endX ?? w.startX]);
      const ys = walls.flatMap((w) => [w.startY, w.endY ?? w.startY]);
      elements.push({
        type: 'Losa',
        material: MATERIALS.Losa,
        startX: Math.min(...xs),
        startY: Math.min(...ys),
        endX: Math.max(...xs),
        endY: Math.max(...ys),
        width: null,
        height: null,
        thickness: DEFAULTS.slabThickness,
        confidence: 0.5,
      });
      slabAssumed = true;
    }

    const rooms = (Array.isArray(reading.rooms) ? reading.rooms : [])
      .filter((r) => r && typeof r.name === 'string' && [r.x1, r.y1, r.x2, r.y2].every(finite))
      .slice(0, 60)
      .map((r) => {
        const x1 = mx(Math.min(r.x1, r.x2));
        const y1 = my(Math.min(r.y1, r.y2));
        const x2 = mx(Math.max(r.x1, r.x2));
        const y2 = my(Math.max(r.y1, r.y2));
        return {
          name: r.name.slice(0, 60),
          x1,
          y1,
          x2,
          y2,
          areaM2: round((x2 - x1) * (y2 - y1)),
          confidence: round(clamp(finite(r.confidence) ? r.confidence : 0.5, 0, 1), 4),
        };
      });

    const dimensions = (Array.isArray(reading.dimensions) ? reading.dimensions : [])
      .filter((d) => d && typeof d.text === 'string')
      .slice(0, 80)
      .map((d) => ({ text: d.text.slice(0, 40), meters: finite(d.meters) ? round(d.meters, 3) : null }));

    const scaleText = typeof reading.scaleText === 'string' ? reading.scaleText.slice(0, 20) : null;
    if (scaleText && scaleText.replace(/\s/g, '') !== image.scale.replace(/\s/g, '')) {
      issues.push(`El plano indica escala ${scaleText}, pero se analizó con ${image.scale}. Confírmala.`);
    }
    if (!scaleText && dimensions.length === 0) {
      issues.push('El plano no muestra escala ni cotas: confirma una medida de referencia antes de usar las dimensiones.');
    }

    const assumptions = [
      assumption('wallHeight', `${DEFAULTS.wallHeight} m`, 'assumed'),
      assumption('wallThickness', `${DEFAULTS.wallThickness} m`, 'assumed'),
      assumption('columnHeight', `${DEFAULTS.columnHeight} m`, 'assumed'),
      assumption('doorHeight', `${DEFAULTS.doorHeight} m`, 'assumed'),
      assumption('windowHeight', `${DEFAULTS.windowHeight} m`, 'assumed'),
      assumption('slabThickness', `${DEFAULTS.slabThickness} m`, 'assumed'),
      assumption('scale', image.scale, scaleText ? 'detected' : 'user'),
      ...(slabAssumed ? [assumption('slabOutline', 'Sobre el contorno de los muros', 'assumed')] : []),
    ];

    const count = (type: ElementTypeName) => elements.filter((e) => e.type === type).length;
    return {
      elements,
      summary: {
        analyzer: image.name,
        modelIdentifier: image.modelIdentifier,
        imageSize: { width: image.width, height: image.height },
        metersPerPixel: round(mpp, 5),
        scaleText,
        warnings: issues,
        assumptions,
        rooms,
        dimensions,
        counts: {
          walls: count('Muro'),
          columns: count('Columna'),
          doors: count('Puerta'),
          windows: count('Ventana'),
          beams: count('Viga'),
          stairs: count('Escalera'),
          rooms: rooms.length,
        },
        note: 'Gemini interpreta el dibujo; las medidas salen de la escala y los valores sin cota son supuestos editables.',
      },
    };
  }
}
