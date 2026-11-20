import { config } from '../config.ts';
import { GeminiClient, GeminiError } from '../gemini/GeminiClient.ts';
import { BadRequestError } from '../imageDownloader.ts';

export const RENDER_STYLES = {
  moderno: 'moderno: líneas limpias, concreto claro, vidrio amplio, carpintería negra',
  tropical: 'tropical: madera natural, vegetación abundante, aleros amplios, tonos cálidos',
  rustico: 'rústico: piedra, madera envejecida, teja de barro, acabados artesanales',
  contemporaneo: 'contemporáneo: volúmenes sobrios, revoque blanco, acentos en madera y metal',
  minimalista: 'minimalista: blanco dominante, pocos materiales, superficies lisas, luz suave',
  tradicional: 'tradicional colombiano: muros blancos, teja de barro, balcones y carpintería de madera',
} as const;
export type RenderStyle = keyof typeof RENDER_STYLES;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface RenderResult {
  mimeType: string;
  data: string;
  model: string;
  disclaimer: string;
  note: string;
}

/**
 * AI render from a view of the 3D model (proposal section 6, "el render debe
 * derivarse del modelo 3D, no reemplazarlo"). The browser sends a capture of
 * the Three.js viewer and Gemini dresses it with materials and light. The
 * geometry stays in Three.js; the image is a visual proposal only.
 *
 * Off unless GEMINI_IMAGE_MODEL is set, because image models are paid only.
 */
export class RenderService {
  constructor(
    private readonly client = new GeminiClient(),
    private readonly model = config.gemini.imageModel,
  ) {}

  get enabled(): boolean {
    return this.client.configured && this.model.length > 0;
  }

  async render(body: Record<string, unknown>): Promise<RenderResult> {
    if (!this.enabled) {
      throw new GeminiError('Los renders con IA no están habilitados en este servicio (falta GEMINI_IMAGE_MODEL).');
    }
    const style = typeof body.style === 'string' && body.style in RENDER_STYLES ? (body.style as RenderStyle) : null;
    if (!style) throw new BadRequestError(`Elige un estilo: ${Object.keys(RENDER_STYLES).join(', ')}.`);
    const scene = body.scene === 'interior' ? 'interior' : 'exterior';
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 300) : '';
    const image = RenderService.decodeImage(body.image);

    const prompt = [
      `Convierte esta captura de una maqueta 3D en un render arquitectónico ${scene} fotorrealista, estilo ${RENDER_STYLES[style]}.`,
      'Conserva exactamente la geometría: la misma forma del edificio, el mismo número y la misma posición de muros, puertas y ventanas, el mismo encuadre de cámara.',
      'Solo cambia materiales, texturas, iluminación natural, cielo y vegetación del entorno. No agregues pisos, ventanas ni volúmenes.',
      notes ? `Indicaciones del usuario (solo estéticas): ${notes}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.generateImage({ model: this.model, prompt, image });
    return {
      ...result,
      model: this.model,
      disclaimer: 'Propuesta visual generada con IA a partir del modelo 3D. No es un plano constructivo ni documentación aprobada.',
    };
  }

  /** Accepts a base64 PNG or JPEG (with or without data: prefix) and checks its real type. */
  static decodeImage(value: unknown): { mimeType: string; data: string } {
    if (typeof value !== 'string' || !value) throw new BadRequestError('Falta la imagen del modelo 3D.');
    const data = value.replace(/^data:image\/(png|jpeg);base64,/, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new BadRequestError('La imagen no está en base64.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequestError('La captura pesa más de 4 MB.');
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) throw new BadRequestError('La captura debe ser PNG o JPEG.');
    return { mimeType: isPng ? 'image/png' : 'image/jpeg', data };
  }
}
