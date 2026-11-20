import { config } from './config.ts';

export class BadRequestError extends Error {}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/**
 * The URL is compared after the URL parser normalizes it, so "user@host",
 * "host.evil.com", "../" segments or odd casing cannot slip past a prefix.
 */
export function isAllowedImageUrl(url: string, prefixes: string[] = config.imageUrlPrefixes): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return prefixes.some((prefix) => parsed.href.startsWith(prefix));
}

/**
 * Downloads the plan image from the backend. Only URLs from the allowed
 * prefixes are accepted, so the service cannot be used to reach other sites.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  if (!isAllowedImageUrl(url)) {
    throw new BadRequestError('La imagen debe venir del backend de Render.IA.');
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(config.downloadTimeoutMs), redirect: 'error' });
  } catch {
    throw new BadRequestError('No se pudo descargar la imagen del plano.');
  }
  if (!response.ok) {
    throw new BadRequestError(`No se pudo descargar la imagen del plano (código ${response.status}).`);
  }

  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ACCEPTED.includes(type)) {
    throw new BadRequestError('Formato de imagen no válido. Debe ser PNG, JPG, WEBP o SVG.');
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > config.maxImageBytes) {
    throw new BadRequestError('La imagen del plano pesa más de 10 MB.');
  }
  return bytes;
}
