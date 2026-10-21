/** Element types of the element_types catalog. */
export type ElementTypeName = 'Muro' | 'Columna' | 'Viga' | 'Losa' | 'Puerta' | 'Ventana' | 'Escalera';

/**
 * Element found in a plan. Coordinates and sizes are in meters on the plan
 * (x to the right, y downwards, origin at the top-left corner of the image).
 */
export interface DetectedElement {
  type: ElementTypeName;
  /** Material name from the materials catalog, or null when unknown. */
  material: string | null;
  startX: number;
  startY: number;
  endX: number | null;
  endY: number | null;
  /** Size across the element (columns: side along x; beams: section width). */
  width: number | null;
  /** Vertical size in the 3D model. */
  height: number | null;
  /** Wall or slab thickness; for columns, side along y. */
  thickness: number | null;
  /** How sure the model is, from 0 to 1. */
  confidence: number;
}

export interface AnalysisInput {
  /** Image of the plan already downloaded. */
  image: Buffer;
  /** Drawing scale written as "1:100". */
  scale: string;
  /** Exact model to use inside the provider (ai_models.model_identifier). */
  modelIdentifier: string;
}

export interface AnalysisOutput {
  elements: DetectedElement[];
  /** Technical details that the backend saves in ai_analyses.raw_response. */
  summary: Record<string, unknown>;
}

/**
 * Pattern: Strategy — every AI provider reads a plan in its own way behind
 * this same interface, so the service can switch models without changing
 * anything else.
 */
export interface PlanAnalyzer {
  /** Value of ai_models.provider that selects this analyzer. */
  readonly provider: string;
  readonly name: string;
  analyze(input: AnalysisInput): Promise<AnalysisOutput>;
}
