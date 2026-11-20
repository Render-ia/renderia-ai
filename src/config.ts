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
    /** Google AI Studio key. Without it Gemini is off and the geometric detector works alone. */
    apiKey: clean(process.env.GEMINI_API_KEY),
    /** Fast model for plans and the copilot. Checked against ai.google.dev/gemini-api/docs/models on 2026-11-20. */
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash',
    /** Lighter model tried when the main one is saturated (503/429). Empty string = no backup model. */
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() ?? 'gemini-3.5-flash-lite',
    /** Model for deep questions to the copilot. Empty = use GEMINI_MODEL (no stable Pro model exists today). */
    modelPro: process.env.GEMINI_MODEL_PRO?.trim() || '',
    /** Image model for AI renders. Empty = renders off. Image models have no free tier, so they are opt-in. */
    imageModel: process.env.GEMINI_IMAGE_MODEL?.trim() || '',
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000),
    /** Maximum Gemini calls per UTC day for the whole service. */
    dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT ?? 300),
    imageDailyLimit: Number(process.env.GEMINI_IMAGE_DAILY_LIMIT ?? 20),
  },
};

/** Stops the service from starting in production with an open API. */
export function assertSafeConfig(): void {
  if (config.production && config.apiKey.length < 24) {
    throw new Error('AI_API_KEY es obligatoria en producción (mínimo 24 caracteres). Genera una con: openssl rand -hex 32');
  }
}

/**
 * Turns ai_models.model_identifier into a Gemini model id. "gemini:flash" and
 * "gemini:pro" follow the environment, so the model changes without touching
 * the database or the code; any other value is used as a literal model id.
 */
export function resolveGeminiModel(identifier: string | undefined): string {
  const value = (identifier ?? '').trim();
  if (!value || value === 'gemini' || value === 'gemini:flash') return config.gemini.model;
  if (value === 'gemini:pro') return config.gemini.modelPro || config.gemini.model;
  return value;
}
