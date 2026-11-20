/** Settings read from environment variables, with safe defaults for local work. */
function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value: string | undefined): string {
  // Keys pasted into a dashboard often carry spaces or line breaks.
  return (value ?? '').replace(/\s/g, '');
}

const production = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

export const config = {
  production,
  port: Number(process.env.PORT ?? 8000),
  /** Shared key with the backend. Required in production: every POST must send it in X-API-Key. */
  apiKey: clean(process.env.AI_API_KEY),
  /** The service only downloads images whose URL starts with one of these prefixes. */
  imageUrlPrefixes: list(
    process.env.IMAGE_URL_PREFIXES,
    production ? ['https://renderia-backend.onrender.com/'] : ['https://renderia-backend.onrender.com/', 'http://localhost:8080/'],
  ),
  maxImageBytes: 10 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
  gemini: {
    /** Google AI Studio key. Without it the "gemini" provider answers with a clear error. */
    apiKey: clean(process.env.GEMINI_API_KEY),
    /** Model for the copilot (the plan model comes from ai_models.model_identifier). */
    chatModel: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-2.5-flash',
    baseUrl: process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000),
  },
};

/** Stops the service from starting in production with an open API. */
export function assertSafeConfig(): void {
  if (config.production && config.apiKey.length < 24) {
    throw new Error('AI_API_KEY es obligatoria en producción (mínimo 24 caracteres). Genera una con: openssl rand -hex 32');
  }
}
