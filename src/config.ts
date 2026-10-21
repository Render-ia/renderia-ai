/** Settings read from environment variables, with safe defaults for local work. */
function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8000),
  /** If set, every /analyze request must send it in the X-API-Key header. */
  apiKey: process.env.AI_API_KEY ?? '',
  /** The service only downloads images whose URL starts with one of these prefixes. */
  imageUrlPrefixes: list(process.env.IMAGE_URL_PREFIXES, [
    'https://renderia-backend.onrender.com/',
    'http://localhost:8080/',
  ]),
  maxImageBytes: 10 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
};
