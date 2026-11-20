import { ApiError, GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { config } from '../config.ts';
import { GeminiError } from './errors.ts';
import { GeminiBudget } from './GeminiBudget.ts';

export { GeminiError };

/** The one SDK call we use; tests replace it with a fake. */
export type GenerateFn = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export interface JsonRequest {
  model: string;
  system?: string;
  contents: Content[];
  /** Standard JSON Schema; Gemini answers with JSON that follows it. */
  schema: Record<string, unknown>;
  temperature?: number;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  image?: { mimeType: string; data: string };
}

/** Internal: a failed call with its HTTP status, so the caller can try the backup model. */
class GeminiStatusError extends Error {
  constructor(readonly status: number) {
    super(`Gemini status ${status}`);
  }
}

const RETRYABLE = new Set([429, 500, 503]);
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,80}$/;

/**
 * Pattern: Adapter — the only class that talks to Gemini, through the official
 * SDK (@google/genai). The rest of the service asks for "JSON that follows this
 * schema" or "an image" and never sees SDK types, retries or HTTP codes.
 *
 * Every call goes through GeminiBudget, so a bug or an abusive client cannot
 * spend more than the daily limit configured for the service.
 */
export class GeminiClient {
  private generateFn: GenerateFn | null;

  constructor(
    private readonly apiKey = config.gemini.apiKey,
    generate?: GenerateFn,
    private readonly budget = GeminiBudget.shared,
    private readonly timeoutMs = config.gemini.timeoutMs,
    private readonly fallbackModel = config.gemini.fallbackModel,
  ) {
    this.generateFn = generate ?? null;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async generateJson<T>(request: JsonRequest): Promise<T> {
    const response = await this.call(
      {
        model: request.model,
        contents: request.contents,
        config: {
          ...(request.system ? { systemInstruction: request.system } : {}),
          temperature: request.temperature ?? 0.1,
          responseMimeType: 'application/json',
          responseJsonSchema: request.schema,
        },
      },
      'text',
    );
    const text = response.text ?? '';
    if (!text.trim()) throw new GeminiError('Gemini devolvió una respuesta vacía.');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiError('Gemini devolvió una respuesta que no es JSON válido.');
    }
  }

  /** Returns the first image Gemini produces, as base64 PNG/JPEG. */
  async generateImage(request: ImageRequest): Promise<{ mimeType: string; data: string; note: string }> {
    const parts: Part[] = [{ text: request.prompt }];
    if (request.image) parts.push({ inlineData: request.image });
    const response = await this.call(
      { model: request.model, contents: [{ role: 'user', parts }], config: { responseModalities: ['TEXT', 'IMAGE'] } },
      'image',
    );
    const outParts = response.candidates?.[0]?.content?.parts ?? [];
    const image = outParts.find((p) => p.inlineData?.data);
    if (!image?.inlineData?.data) throw new GeminiError('Gemini no devolvió ninguna imagen. Prueba con otra descripción.');
    const note = outParts.map((p) => p.text ?? '').join(' ').trim().slice(0, 500);
    return { mimeType: image.inlineData.mimeType ?? 'image/png', data: image.inlineData.data, note };
  }

  private async call(params: GenerateContentParameters, kind: 'text' | 'image'): Promise<GenerateContentResponse> {
    if (!this.configured) {
      throw new GeminiError('Gemini no está configurado en el servicio de IA (falta GEMINI_API_KEY).');
    }
    if (!MODEL_ID.test(params.model)) {
      throw new GeminiError(`El identificador de modelo "${params.model}" no es válido.`);
    }
    this.budget.take(kind);

    try {
      return await this.attempt(params);
    } catch (error) {
      // The main model is saturated: a lighter model of the same family usually still answers.
      const status = error instanceof GeminiStatusError ? error.status : -1;
      const backup = this.fallbackModel;
      if (kind !== 'text' || !backup || backup === params.model || !(status === 0 || RETRYABLE.has(status))) {
        throw error instanceof GeminiStatusError ? new GeminiError(GeminiClient.describeStatus(status)) : error;
      }
      console.warn(`[gemini] ${params.model} saturado, se intenta con ${backup}`);
      try {
        return await this.attempt({ ...params, model: backup });
      } catch (second) {
        throw second instanceof GeminiStatusError ? new GeminiError(GeminiClient.describeStatus(second.status)) : second;
      }
    }
  }

  /** Up to three tries on one model, waiting a little longer each time. */
  private async attempt(params: GenerateContentParameters): Promise<GenerateContentResponse> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.generate()({
          ...params,
          config: { ...params.config, abortSignal: AbortSignal.timeout(this.timeoutMs) },
        });
        if (response.promptFeedback?.blockReason) {
          throw new GeminiError('Gemini rechazó la solicitud por sus filtros de seguridad.');
        }
        return response;
      } catch (error) {
        if (error instanceof GeminiError) throw error;
        lastStatus = error instanceof ApiError ? error.status : 0;
        const retry = attempt < 3 && RETRYABLE.has(lastStatus);
        // Only the status goes to the log: the error body can echo the prompt or the plan.
        console.warn(`[gemini] intento ${attempt} falló (estado ${lastStatus || 'sin respuesta'})`);
        if (!retry) break;
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
    throw new GeminiStatusError(lastStatus);
  }

  private generate(): GenerateFn {
    if (!this.generateFn) {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });
      this.generateFn = (params) => ai.models.generateContent(params);
    }
    return this.generateFn;
  }

  /** Messages for the user; the details stay out of the response. */
  static describeStatus(status: number): string {
    if (status === 0) return 'Gemini no respondió a tiempo. Inténtalo de nuevo en un momento.';
    if (status === 400) return 'Gemini no aceptó la solicitud (revisa el identificador del modelo).';
    if (status === 401 || status === 403) return 'La clave de Gemini no es válida o no tiene permiso para ese modelo.';
    if (status === 404) return 'El modelo de Gemini indicado no existe o ya no está disponible.';
    if (status === 429) return 'Se alcanzó el límite de uso de Gemini. Espera un minuto e inténtalo de nuevo.';
    return `Gemini no está disponible en este momento (código ${status}).`;
  }
}
