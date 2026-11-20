import { config } from '../config.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Error that the user can read: the server answers 422 with this message. */
export class GeminiError extends Error {}

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequest {
  model: string;
  system?: string;
  contents: GeminiContent[];
  /** OpenAPI-style schema; Gemini then answers with JSON that follows it. */
  responseSchema: Record<string, unknown>;
  temperature?: number;
}

const RETRYABLE = new Set([429, 500, 503]);
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,80}$/;

/**
 * Thin HTTP client for the Gemini API (generateContent). It knows nothing
 * about plans: it sends parts, asks for JSON and returns the parsed object.
 *
 * The key travels in the x-goog-api-key header, never in the URL, so it does
 * not end up in proxy or access logs.
 */
export class GeminiClient {
  constructor(
    private readonly apiKey = config.gemini.apiKey,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = config.gemini.baseUrl,
    private readonly timeoutMs = config.gemini.timeoutMs,
  ) {}

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async generateJson<T>(request: GeminiRequest): Promise<T> {
    if (!this.configured) {
      throw new GeminiError('Gemini no está configurado en el servicio de IA (falta GEMINI_API_KEY).');
    }
    if (!MODEL_ID.test(request.model)) {
      throw new GeminiError(`El identificador de modelo "${request.model}" no es válido.`);
    }

    const body = JSON.stringify({
      ...(request.system ? { system_instruction: { parts: [{ text: request.system }] } } : {}),
      contents: request.contents,
      generationConfig: {
        temperature: request.temperature ?? 0.1,
        responseMimeType: 'application/json',
        responseSchema: request.responseSchema,
      },
    });

    const url = `${this.baseUrl}/models/${request.model}:generateContent`;
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt === 2) throw new GeminiError('Gemini no respondió a tiempo. Inténtalo de nuevo en un momento.');
        continue;
      }
      if (!RETRYABLE.has(response.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (!response!.ok) {
      throw new GeminiError(GeminiClient.describeStatus(response!.status));
    }

    const payload = (await response!.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    if (payload.promptFeedback?.blockReason) {
      throw new GeminiError('Gemini rechazó la solicitud por sus filtros de seguridad.');
    }
    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
      throw new GeminiError('Gemini devolvió una respuesta vacía.');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiError('Gemini devolvió una respuesta que no es JSON válido.');
    }
  }

  /** Messages for the user; the HTTP details stay in the server log. */
  static describeStatus(status: number): string {
    if (status === 400) return 'Gemini no aceptó la solicitud (revisa el identificador del modelo).';
    if (status === 401 || status === 403) return 'La clave de Gemini no es válida o no tiene permiso.';
    if (status === 404) return 'El modelo de Gemini indicado no existe.';
    if (status === 429) return 'Se alcanzó el límite de uso de Gemini. Espera un minuto e inténtalo de nuevo.';
    return `Gemini no está disponible en este momento (código ${status}).`;
  }
}
