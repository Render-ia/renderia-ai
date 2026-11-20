/**
 * Message that is safe to show to the user for an unexpected error.
 * Our analyzers throw Spanish messages meant for people; the image library
 * (libvips through sharp) throws English internals such as "Input image
 * exceeds pixel limit" or XML parser details, which say nothing useful to
 * the user and reveal how the service is built.
 */
const IMAGE_LIBRARY = /(input (file|buffer|image)|pixel limit|corrupt header|unsupported image format|vips|glib|libspng|libjpeg|libwebp|librsvg|xml parse|expected .* got)/i;

export const UNREADABLE_IMAGE =
  'No se pudo leer la imagen del plano. Súbela como PNG, JPG, WEBP o SVG válido, de máximo 16.000 píxeles por lado.';

export function publicMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return 'Error inesperado al analizar el plano.';
  if (IMAGE_LIBRARY.test(error.message)) return UNREADABLE_IMAGE;
  return error.message.length > 300 ? `${error.message.slice(0, 300)}…` : error.message;
}
