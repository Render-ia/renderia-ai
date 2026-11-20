import { resolveGeminiModel } from '../config.ts';
import { GeminiError } from '../gemini/GeminiClient.ts';
import { GeminiPlanReader, type GeminiPlanReading } from '../gemini/PlanReader.ts';
import { LocalVisionAnalyzer } from './LocalVisionAnalyzer.ts';
import type { AnalysisInput, AnalysisOutput, DetectedElement, ElementTypeName, PlanAnalyzer } from './PlanAnalyzer.ts';

/** Types whose count is compared between the two readings. */
const CHECKED: { type: ElementTypeName; label: string }[] = [
  { type: 'Puerta', label: 'puertas' },
  { type: 'Ventana', label: 'ventanas' },
  { type: 'Columna', label: 'columnas' },
];

/** Confidence kept for Gemini's geometry when the geometric detector could not read the plan. */
const FALLBACK_CONFIDENCE_FACTOR = 0.8;

/**
 * Gemini + geometric vision ("gemini" in ai_models).
 *
 * Gemini complements the deterministic detector instead of replacing it:
 * 1. The geometric detector measures walls, columns, openings and beams.
 * 2. Gemini reads what geometry cannot: room names, written dimensions, the
 *    scale written on the sheet and quality problems.
 * 3. Both readings are compared; disagreements become warnings to review.
 * 4. Only when the geometric detector cannot read the plan at all (a photo,
 *    hand drawing...) Gemini's geometry is used, with lower confidence and a
 *    clear note that it must be validated.
 * If Gemini is not configured or fails, the geometric result is returned
 * with a warning, so the analysis never depends on an external service.
 */
export class GeminiAnalyzer implements PlanAnalyzer {
  readonly provider = 'gemini';
  readonly name = 'Gemini + visión geométrica';

  constructor(
    private readonly reader = new GeminiPlanReader(),
    private readonly geometry: PlanAnalyzer = new LocalVisionAnalyzer(),
  ) {}

  get configured(): boolean {
    return this.reader.configured;
  }

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const model = resolveGeminiModel(input.modelIdentifier);
    const [geometric, gemini] = await Promise.allSettled([
      this.geometry.analyze(input),
      this.reader.read(input.image, model),
    ]);

    let interpretation: AnalysisOutput | null = null;
    let geminiProblem: string | null = null;
    if (gemini.status === 'fulfilled') {
      try {
        interpretation = GeminiPlanReader.toOutput(gemini.value.reading, {
          width: gemini.value.width,
          height: gemini.value.height,
          scale: input.scale,
          modelIdentifier: model,
          name: this.name,
        });
      } catch (error) {
        geminiProblem = (error as Error).message;
      }
    } else {
      geminiProblem = gemini.reason instanceof Error ? gemini.reason.message : 'Gemini no respondió.';
    }

    if (geometric.status === 'fulfilled') {
      const base = geometric.value;
      const extra = interpretation?.summary ?? {};
      const warnings = [
        ...((extra.warnings as string[] | undefined) ?? []),
        ...(gemini.status === 'fulfilled' ? GeminiAnalyzer.crossCheck(base.elements, gemini.value.reading) : []),
        ...(geminiProblem ? [`Gemini no participó (${geminiProblem}). Se muestra solo la geometría detectada.`] : []),
      ];
      return {
        elements: base.elements,
        summary: {
          ...base.summary,
          analyzer: this.name,
          modelIdentifier: model,
          geometrySource: 'Detector geométrico (determinista)',
          interpretationSource: interpretation ? `Gemini (${model})` : null,
          rooms: extra.rooms ?? [],
          dimensions: extra.dimensions ?? [],
          scaleText: extra.scaleText ?? null,
          assumptions: GeminiAnalyzer.geometricAssumptions(input.scale, (extra.scaleText as string | null) ?? null),
          warnings,
        },
      };
    }

    // The geometric detector could not read the plan: fall back to Gemini's geometry, flagged as a proposal.
    if (interpretation) {
      return {
        elements: interpretation.elements.map((e) => ({
          ...e,
          confidence: Number((e.confidence * FALLBACK_CONFIDENCE_FACTOR).toFixed(4)),
        })),
        summary: {
          ...interpretation.summary,
          geometrySource: 'Gemini (propuesta: el detector geométrico no pudo leer el plano)',
          interpretationSource: `Gemini (${model})`,
          warnings: [
            `El detector geométrico no pudo leer el plano (${(geometric.reason as Error).message}). La geometría la propuso Gemini: valida cada elemento antes de usar medidas.`,
            ...((interpretation.summary.warnings as string[] | undefined) ?? []),
          ],
        },
      };
    }

    // Neither worked: the geometric message is usually the most useful one.
    const reason = geometric.reason instanceof Error ? geometric.reason.message : 'No se pudo analizar el plano.';
    throw new GeminiError(geminiProblem ? `${reason} Gemini tampoco pudo leerlo: ${geminiProblem}` : reason);
  }

  /** Compares how many doors, windows and columns each reading found. */
  static crossCheck(elements: DetectedElement[], reading: GeminiPlanReading): string[] {
    const warnings: string[] = [];
    const geminiElements = Array.isArray(reading.elements) ? reading.elements : [];
    for (const { type, label } of CHECKED) {
      const geometric = elements.filter((e) => e.type === type).length;
      const seen = geminiElements.filter((e) => e?.type === type).length;
      if (geometric !== seen && Math.abs(geometric - seen) >= Math.max(1, Math.round(Math.max(geometric, seen) * 0.2))) {
        warnings.push(`El detector geométrico encontró ${geometric} ${label} y Gemini ve ${seen}. Revisa las ${label} en el plano.`);
      }
    }
    return warnings;
  }

  static geometricAssumptions(scale: string, scaleText: string | null) {
    return [
      { field: 'Escala', value: scale, source: scaleText ? 'detectado' : 'indicado por el usuario' },
      { field: 'Espesor de muros', value: 'Medido en el dibujo', source: 'detectado' },
      { field: 'Altura de muros', value: '2.5 m', source: 'supuesto' },
      { field: 'Altura de columnas', value: '2.8 m', source: 'supuesto' },
      { field: 'Altura de puertas', value: '2.1 m', source: 'supuesto' },
      { field: 'Altura de ventanas', value: '1.2 m', source: 'supuesto' },
      { field: 'Vigas', value: 'Entre columnas unidas por muro, 0.25 × 0.35 m', source: 'supuesto' },
      { field: 'Espesor de losa', value: '0.12 m', source: 'supuesto' },
    ];
  }
}
