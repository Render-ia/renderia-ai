import type { AnalysisInput, AnalysisOutput, DetectedElement, ElementTypeName, PlanAnalyzer } from './PlanAnalyzer.ts';

type Row = [ElementTypeName, number, number, number | null, number | null, number | null, number | null, number | null];

/** Elements of the sample house (public/samples/plano-casa.svg), in meters. */
const SAMPLE: Row[] = [
  ['Muro', 0.64, 0.8, 2.3, 0.8, null, 2.5, 0.15],
  ['Muro', 3.79, 0.8, 8.3, 0.8, null, 2.5, 0.15],
  ['Muro', 9.8, 0.8, 12.95, 0.8, null, 2.5, 0.15],
  ['Muro', 0.64, 4.8, 2.61, 4.8, null, 2.5, 0.12],
  ['Muro', 3.51, 4.8, 6.81, 4.8, null, 2.5, 0.12],
  ['Muro', 7.7, 4.8, 12.95, 4.8, null, 2.5, 0.12],
  ['Muro', 0.64, 8.8, 2.79, 8.8, null, 2.5, 0.15],
  ['Muro', 4.3, 8.8, 10.31, 8.8, null, 2.5, 0.15],
  ['Muro', 11.19, 8.8, 12.95, 8.8, null, 2.5, 0.15],
  ['Muro', 0.8, 0.64, 0.8, 5.81, null, 2.5, 0.15],
  ['Muro', 0.8, 7.3, 0.8, 8.96, null, 2.5, 0.15],
  ['Muro', 5.8, 0.64, 5.8, 3.1, null, 2.5, 0.12],
  ['Muro', 5.8, 4, 5.8, 6.4, null, 2.5, 0.12],
  ['Muro', 5.8, 7.3, 5.8, 8.96, null, 2.5, 0.12],
  ['Muro', 9.3, 4.66, 9.3, 5.5, null, 2.5, 0.12],
  ['Muro', 9.3, 6.4, 9.3, 8.96, null, 2.5, 0.12],
  ['Muro', 12.79, 0.64, 12.79, 2.3, null, 2.5, 0.15],
  ['Muro', 12.79, 3.79, 12.79, 8.96, null, 2.5, 0.15],
  ['Columna', 0.8, 0.8, null, null, 0.3, 2.8, 0.3],
  ['Columna', 5.8, 0.8, null, null, 0.29, 2.8, 0.3],
  ['Columna', 12.8, 0.8, null, null, 0.3, 2.8, 0.3],
  ['Columna', 0.8, 4.8, null, null, 0.3, 2.8, 0.29],
  ['Columna', 5.8, 4.8, null, null, 0.29, 2.8, 0.29],
  ['Columna', 9.3, 4.8, null, null, 0.3, 2.8, 0.29],
  ['Columna', 12.8, 4.8, null, null, 0.3, 2.8, 0.29],
  ['Columna', 0.8, 8.81, null, null, 0.3, 2.8, 0.3],
  ['Columna', 5.8, 8.81, null, null, 0.29, 2.8, 0.3],
  ['Columna', 9.3, 8.81, null, null, 0.3, 2.8, 0.3],
  ['Columna', 12.8, 8.81, null, null, 0.3, 2.8, 0.3],
  ['Ventana', 2.3, 0.8, 3.79, 0.8, 1.49, 1.2, 0.15],
  ['Ventana', 8.3, 0.8, 9.8, 0.8, 1.51, 1.2, 0.15],
  ['Puerta', 2.61, 4.8, 3.51, 4.8, 0.9, 2.1, 0.12],
  ['Puerta', 6.81, 4.8, 7.7, 4.8, 0.9, 2.1, 0.12],
  ['Ventana', 2.79, 8.8, 4.3, 8.8, 1.51, 1.2, 0.15],
  ['Puerta', 10.31, 8.8, 11.19, 8.8, 0.88, 2.1, 0.15],
  ['Ventana', 0.8, 5.81, 0.8, 7.3, 1.49, 1.2, 0.15],
  ['Puerta', 5.8, 3.1, 5.8, 4, 0.9, 2.1, 0.12],
  ['Puerta', 5.8, 6.4, 5.8, 7.3, 0.9, 2.1, 0.12],
  ['Puerta', 9.3, 5.5, 9.3, 6.4, 0.9, 2.1, 0.12],
  ['Ventana', 12.79, 2.3, 12.79, 3.79, 1.49, 1.2, 0.15],
  ['Viga', 0.8, 0.8, 5.8, 0.8, 0.25, 0.35, 0.25],
  ['Viga', 5.8, 0.8, 12.8, 0.8, 0.25, 0.35, 0.25],
  ['Viga', 0.8, 4.8, 5.8, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 5.8, 4.8, 9.3, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 9.3, 4.8, 12.8, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 0.8, 8.81, 5.8, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 5.8, 8.81, 9.3, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 9.3, 8.81, 12.8, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 0.8, 0.8, 0.8, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 5.8, 0.8, 5.8, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 12.8, 0.8, 12.8, 4.8, 0.25, 0.35, 0.25],
  ['Viga', 0.8, 4.8, 0.8, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 5.8, 4.8, 5.8, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 9.3, 4.8, 9.3, 8.81, 0.25, 0.35, 0.25],
  ['Viga', 12.8, 4.8, 12.8, 8.81, 0.25, 0.35, 0.25],
  ['Losa', 0.64, 0.64, 12.95, 8.96, null, null, 0.12],
];

const MATERIALS: Record<ElementTypeName, string | null> = {
  Muro: 'Ladrillo',
  Columna: 'Concreto reforzado',
  Viga: 'Concreto reforzado',
  Losa: 'Concreto reforzado',
  Puerta: 'Madera',
  Ventana: null,
  Escalera: 'Concreto reforzado',
};

/**
 * "Respuesta de ejemplo" (provider "mock" in ai_models). Always returns the
 * elements of the sample house, whatever plan it receives. Useful to show the
 * full flow without depending on a real model.
 */
export class SampleAnalyzer implements PlanAnalyzer {
  readonly provider = 'mock';
  readonly name = 'Respuesta de ejemplo';

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const elements: DetectedElement[] = SAMPLE.map(([type, startX, startY, endX, endY, width, height, thickness]) => ({
      type,
      material: MATERIALS[type],
      startX,
      startY,
      endX,
      endY,
      width,
      height,
      thickness,
      confidence: 1,
    }));

    return {
      elements,
      summary: {
        analyzer: this.name,
        modelIdentifier: input.modelIdentifier,
        note: 'Respuesta fija del plano de ejemplo; no lee la imagen recibida.',
        counts: { total: elements.length },
      },
    };
  }
}
