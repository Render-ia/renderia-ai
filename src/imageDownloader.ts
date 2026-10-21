import { config } from './config.ts';

export class BadRequestError extends Error {}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/**
 * Downloads the plan image from the backend. Only URLs from the allowed
 * prefixes are accepted, so the service cannot be used to reach other sites.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  if (!config.imageUrlPrefixes.some((prefix) => url.startsWith(prefix))) {
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
