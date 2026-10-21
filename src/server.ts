import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AnalysisService } from './analysisService.ts';
import { config } from './config.ts';
import { BadRequestError } from './imageDownloader.ts';

const MAX_BODY_BYTES = 64 * 1024;
const service = new AnalysisService();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('El cuerpo de la petición es demasiado grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new BadRequestError('El cuerpo de la petición no es un JSON válido.');
  }
}

function hasValidKey(req: IncomingMessage): boolean {
  if (!config.apiKey) return true;
  const given = Buffer.from(String(req.headers['x-api-key'] ?? ''));
  const expected = Buffer.from(config.apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  try {
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      return send(res, 200, { status: 'ok', service: 'renderia-ai' });
    }

    if (req.method === 'GET' && path === '/models') {
      return send(res, 200, service.availableModels());
    }

    if (req.method === 'POST' && path === '/analyze') {
      if (!hasValidKey(req)) return send(res, 401, { message: 'Clave del servicio de IA inválida.' });
      const body = await readJson(req);
      const result = await service.analyze(body);
      return send(res, 200, result);
    }

    return send(res, 404, { message: 'Ruta no encontrada.' });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return send(res, 400, { message: error.message });
    }
    // Errors thrown by the analyzer (blank plan, no walls...) are meant for the user.
    const message = error instanceof Error ? error.message : 'Error inesperado al analizar el plano.';
    console.error('[analyze]', message);
    return send(res, 422, { message });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(config.port, () => {
    console.log(`renderia-ai escuchando en el puerto ${config.port}`);
  });
}
