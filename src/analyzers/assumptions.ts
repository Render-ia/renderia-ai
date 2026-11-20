/**
 * Values the plan rarely states. Each analyzer reports them in
 * summary.assumptions so the user can confirm or change them. `key` is the
 * stable id the frontend uses; `label` and `value` are shown to the user.
 */
export type AssumptionSource = 'assumed' | 'detected' | 'user';

export type AssumptionKey =
  | 'scale'
  | 'wallThickness'
  | 'wallHeight'
  | 'columnHeight'
  | 'doorHeight'
  | 'windowHeight'
  | 'beamSize'
  | 'slabThickness'
  | 'slabOutline';

export interface Assumption {
  key: AssumptionKey;
  label: string;
  value: string;
  source: AssumptionSource;
}

export const ASSUMPTION_LABELS: Record<AssumptionKey, string> = {
  scale: 'Escala',
  wallThickness: 'Espesor de muros',
  wallHeight: 'Altura de muros',
  columnHeight: 'Altura de columnas',
  doorHeight: 'Altura de puertas',
  windowHeight: 'Altura de ventanas',
  beamSize: 'Vigas',
  slabThickness: 'Espesor de losa',
  slabOutline: 'Losa',
};

export const assumption = (key: AssumptionKey, value: string, source: AssumptionSource): Assumption => ({
  key,
  label: ASSUMPTION_LABELS[key],
  value,
  source,
});
