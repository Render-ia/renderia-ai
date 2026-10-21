import { AnalyzerFactory } from './analyzers/AnalyzerFactory.ts';
import type { DetectedElement } from './analyzers/PlanAnalyzer.ts';
import { BadRequestError, downloadImage } from './imageDownloader.ts';
import { scaleDenominator } from './scale.ts';

export interface AnalyzeRequest {
  imageUrl?: unknown;
  scale?: unknown;
  provider?: unknown;
  modelIdentifier?: unknown;
}

export interface AnalyzeResponse {
  provider: string;
  model: string;
  durationMs: number;
  elements: DetectedElement[];
  summary: Record<string, unknown>;
}

/**
 * Pattern: Facade — one call hides the whole process: validate the request,
 * download the image, choose the analyzer and run it.
 */
export class AnalysisService {
  constructor(private readonly factory = new AnalyzerFactory()) {}

  availableModels() {
    return this.factory.list();
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    const imageUrl = text(request.imageUrl, 'imageUrl');
    const scale = text(request.scale, 'scale');
    const provider = text(request.provider, 'provider');
    const modelIdentifier = typeof request.modelIdentifier === 'string' ? request.modelIdentifier : provider;

    try {
      scaleDenominator(scale);
    } catch (error) {
      throw new BadRequestError((error as Error).message);
    }

    const analyzer = this.factory.forProvider(provider);
    if (!analyzer) {
      throw new BadRequestError(`El proveedor de IA "${provider}" no está disponible en este servicio.`);
    }

    const image = await downloadImage(imageUrl);
    const started = performance.now();
    const output = await analyzer.analyze({ image, scale, modelIdentifier });

    return {
      provider: analyzer.provider,
      model: analyzer.name,
      durationMs: Math.round(performance.now() - started),
      elements: output.elements,
      summary: output.summary,
    };
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`Falta el campo "${field}".`);
  }
  return value.trim();
}
