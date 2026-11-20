import assert from 'node:assert/strict';
import type { Assumption } from '../src/analyzers/assumptions.ts';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { AnalyzerFactory } from '../src/analyzers/AnalyzerFactory.ts';
import { GeminiAnalyzer } from '../src/analyzers/GeminiAnalyzer.ts';
import type { AnalysisInput, AnalysisOutput, PlanAnalyzer } from '../src/analyzers/PlanAnalyzer.ts';
import { AssistantService } from '../src/assistant/AssistantService.ts';
import { resolveGeminiModel } from '../src/config.ts';
import { GeminiBudget } from '../src/gemini/GeminiBudget.ts';
import { GeminiClient, GeminiError } from '../src/gemini/GeminiClient.ts';
import { GeminiPlanReader, type GeminiPlanReading } from '../src/gemini/PlanReader.ts';
import { RenderService } from '../src/render/RenderService.ts';

const samplePath = new URL('../../samples/house-floor-plan.svg', import.meta.url);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type Answer = object | number | 'image';

/** Fake of the SDK call: records the requests and replies with JSON, an image or an HTTP error. */
function fakeGemini(answers: Answer[], budget = new GeminiBudget(100, 100)) {
  const calls: GenerateContentParameters[] = [];
  const generate = async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
    calls.push(params);
    const next = answers.shift() ?? 500;
    if (typeof next === 'number') throw new ApiError({ message: 'boom', status: next });
    if (next === 'image') {
      return { candidates: [{ content: { parts: [{ text: 'listo' }, { inlineData: { mimeType: 'image/png', data: PNG_1PX } }] } }] } as GenerateContentResponse;
    }
    return { text: JSON.stringify(next) } as GenerateContentResponse;
  };
  return { calls, client: new GeminiClient('clave-de-prueba', generate, budget, 5000) };
}

const IMAGE = { width: 1000, height: 500, scale: '1:100', modelIdentifier: 'gemini-test', name: 'Gemini' };
// 1:100 at 150 dpi: 1 px = 0.016933 m, so 1000 px = 16.93 m.
const reading = (overrides: Partial<GeminiPlanReading> = {}): GeminiPlanReading => ({
  legible: true,
  issues: [],
  scaleText: '1:100',
  elements: [
    { type: 'Muro', x1: 100, y1: 100, x2: 900, y2: 104, confidence: 0.92 },
    { type: 'Puerta', x1: 400, y1: 100, x2: 450, y2: 100, confidence: 0.7 },
    { type: 'Columna', x1: 95, y1: 95, x2: 105, y2: 105, confidence: 0.6 },
    { type: 'Ascensor', x1: 1, y1: 1, x2: 2, y2: 2, confidence: 1 },
  ],
  rooms: [{ name: 'Sala', x1: 100, y1: 100, x2: 500, y2: 900, confidence: 0.8 }],
  dimensions: [{ text: '4.50', meters: 4.5 }],
  ...overrides,
});

// ---------- Deterministic conversion of Gemini's reading ----------

test('Gemini reading becomes elements in meters with snapped walls and declared assumptions', () => {
  const { elements, summary } = GeminiPlanReader.toOutput(reading(), IMAGE);
  const wall = elements.find((e) => e.type === 'Muro')!;
  assert.equal(wall.startY, wall.endY, 'a wall 4/1000 off horizontal is snapped');
  assert.equal(wall.startX, 1.69);
  assert.equal(wall.endX, 15.24);
  assert.equal(elements.filter((e) => e.type === 'Puerta')[0].width, 0.85);
  assert.equal(elements.some((e) => (e.type as string) === 'Ascensor'), false, 'unknown types are dropped');
  assert.equal(elements.filter((e) => e.type === 'Losa').length, 1, 'a slab is added when none is drawn');
  const assumptions = summary.assumptions as Assumption[];
  assert.ok(assumptions.some((a) => a.key === 'wallHeight' && a.source === 'assumed'));
});

test('a doubtful "not legible" that still brings elements keeps them and turns the issue into a warning', () => {
  const output = GeminiPlanReader.toOutput(reading({ legible: false, issues: ['textos pequeños'] }), IMAGE);
  assert.ok(output.elements.length > 0);
  assert.ok((output.summary.warnings as string[]).includes('textos pequeños'));
});

test('coordinates outside the image are clamped and confidence stays in 0..1', () => {
  const { elements } = GeminiPlanReader.toOutput(
    reading({ elements: [{ type: 'Muro', x1: -300, y1: 200, x2: 2000, y2: 200, confidence: 3 }] }),
    IMAGE,
  );
  assert.equal(elements[0].startX, 0);
  assert.equal(elements[0].endX, 16.93);
  assert.equal(elements[0].confidence, 1);
});

test('an illegible plan or one without walls is rejected with a clear message', () => {
  assert.throws(
    () => GeminiPlanReader.toOutput(reading({ legible: false, issues: ['borroso'], elements: [], rooms: [] }), IMAGE),
    /borroso/,
  );
  assert.throws(() => GeminiPlanReader.toOutput(reading({ elements: [] }), IMAGE), /no encontró muros/);
});

test('a scale on the sheet that differs from the chosen one becomes a warning', () => {
  const { summary } = GeminiPlanReader.toOutput(reading({ scaleText: '1:50' }), IMAGE);
  assert.match((summary.warnings as string[]).join(' '), /1:50/);
});

// ---------- Client: SDK adapter, retries, errors, budget ----------

test('the client asks for JSON with a schema and retries once on 503', async () => {
  const { calls, client } = fakeGemini([503, { ok: true }]);
  const result = await client.generateJson<{ ok: boolean }>({
    model: 'gemini-3.8-flash',
    system: 'sistema',
    contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
    schema: { type: 'object' },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, 'gemini-3.8-flash');
  assert.equal(calls[1].config?.responseMimeType, 'application/json');
  assert.deepEqual(calls[1].config?.responseJsonSchema, { type: 'object' });
  assert.equal(calls[1].config?.systemInstruction, 'sistema');
  assert.ok(calls[1].config?.abortSignal instanceof AbortSignal, 'every call has a timeout');
});

test('when the main model stays saturated, the client answers with the backup model', async () => {
  const { calls, client } = fakeGemini([503, 503, 503, { ok: true }]);
  const result = await client.generateJson<{ ok: boolean }>({ model: 'gemini-3.8-flash', contents: [], schema: {} });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((call) => call.model),
    ['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  );
  await assert.rejects(fakeGemini([503, 503, 503, 503, 503, 503]).client.generateJson({ model: 'gemini-3.8-flash', contents: [], schema: {} }), /código 503/);
});

test('the client explains a bad key, refuses odd model ids and works without key only to say it is off', async () => {
  const request = { model: 'gemini-3.8-flash', contents: [], schema: {} };
  await assert.rejects(fakeGemini([403]).client.generateJson(request), /clave de Gemini/);
  await assert.rejects(fakeGemini([{}]).client.generateJson({ ...request, model: '../../otra-ruta' }), GeminiError);
  await assert.rejects(new GeminiClient('').generateJson(request), /GEMINI_API_KEY/);
});

test('the daily budget stops calls once it is spent', async () => {
  const { calls, client } = fakeGemini([{ a: 1 }, { a: 2 }, { a: 3 }], new GeminiBudget(2, 0));
  const request = { model: 'gemini-3.8-flash', contents: [], schema: {} };
  await client.generateJson(request);
  await client.generateJson(request);
  await assert.rejects(client.generateJson(request), /cupo diario/);
  assert.equal(calls.length, 2, 'the third call never reaches Gemini');
});

test('model identifiers from ai_models follow the environment', () => {
  assert.equal(resolveGeminiModel('gemini:flash'), 'gemini-3.8-flash');
  assert.equal(resolveGeminiModel('gemini:pro'), 'gemini-3.8-flash', 'without a Pro model configured, the fast one is used');
  assert.equal(resolveGeminiModel('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
});

// ---------- Hybrid analyzer: Gemini complements the geometric detector ----------

class FixedGeometry implements PlanAnalyzer {
  readonly provider = 'local-vision';
  readonly name = 'fijo';
  constructor(private readonly output: AnalysisOutput | Error) {}
  async analyze(_input: AnalysisInput): Promise<AnalysisOutput> {
    if (this.output instanceof Error) throw this.output;
    return this.output;
  }
}

const geometricOutput: AnalysisOutput = {
  elements: [
    { type: 'Muro', material: 'Ladrillo', startX: 0, startY: 0, endX: 5, endY: 0, width: null, height: 2.5, thickness: 0.15, confidence: 0.9 },
    { type: 'Puerta', material: 'Madera', startX: 1, startY: 0, endX: 2, endY: 0, width: 0.9, height: 2.1, thickness: 0.15, confidence: 0.8 },
    { type: 'Puerta', material: 'Madera', startX: 3, startY: 0, endX: 4, endY: 0, width: 0.9, height: 2.1, thickness: 0.15, confidence: 0.8 },
  ],
  summary: { counts: { walls: 1, doors: 2 } },
};

test('with both readings, the geometry stays deterministic and Gemini adds rooms, dimensions and warnings', async () => {
  const image = await readFile(samplePath);
  const { client } = fakeGemini([reading()]);
  const analyzer = new GeminiAnalyzer(new GeminiPlanReader(client), new FixedGeometry(geometricOutput));
  const { elements, summary } = await analyzer.analyze({ image, scale: '1:100', modelIdentifier: 'gemini:flash' });
  assert.deepEqual(elements, geometricOutput.elements, 'Gemini never changes the measured geometry');
  assert.equal((summary.rooms as unknown[]).length, 1);
  assert.match(String(summary.geometrySource), /determinista/);
  assert.match((summary.warnings as string[]).join(' '), /2 puertas y Gemini ve 1/);
});

test('when Gemini reads only rooms, the detector keeps the geometry and Gemini still adds the rooms', async () => {
  const image = await readFile(samplePath);
  const { client } = fakeGemini([reading({ elements: [] })]);
  const analyzer = new GeminiAnalyzer(new GeminiPlanReader(client), new FixedGeometry(geometricOutput));
  const { elements, summary } = await analyzer.analyze({ image, scale: '1:100', modelIdentifier: 'gemini:flash' });
  assert.deepEqual(elements, geometricOutput.elements);
  assert.equal((summary.rooms as unknown[]).length, 1);
  assert.doesNotMatch((summary.warnings as string[]).join(' '), /no participó|Gemini ve/);
  assert.deepEqual(summary.geminiSeen, { elements: 0, rooms: 1, dimensions: (reading().dimensions ?? []).length });
});

test('if Gemini fails, the geometric result is still returned with a warning', async () => {
  const image = await readFile(samplePath);
  const { client } = fakeGemini([429, 429]);
  const analyzer = new GeminiAnalyzer(new GeminiPlanReader(client), new FixedGeometry(geometricOutput));
  const { elements, summary } = await analyzer.analyze({ image, scale: '1:100', modelIdentifier: 'gemini:flash' });
  assert.equal(elements.length, 3);
  assert.match((summary.warnings as string[]).join(' '), /Gemini no participó/);
});

test('if the geometric detector cannot read the plan, Gemini geometry is used as a flagged proposal', async () => {
  const image = await readFile(samplePath);
  const { client } = fakeGemini([reading()]);
  const analyzer = new GeminiAnalyzer(new GeminiPlanReader(client), new FixedGeometry(new Error('No se encontraron muros.')));
  const { elements, summary } = await analyzer.analyze({ image, scale: '1:100', modelIdentifier: 'gemini:flash' });
  assert.equal(elements.find((e) => e.type === 'Muro')!.confidence, 0.736, 'confidence is lowered (0.92 × 0.8)');
  assert.match(String(summary.geometrySource), /propuesta/);
});

test('with the real geometric detector the sample house keeps its 56 elements', async () => {
  const image = await readFile(samplePath);
  const { calls, client } = fakeGemini([reading()]);
  const { elements } = await new GeminiAnalyzer(new GeminiPlanReader(client)).analyze({ image, scale: '1:100', modelIdentifier: 'gemini:flash' });
  assert.equal(elements.length, 56);
  const part = (calls[0].contents as { parts: { inlineData?: { mimeType: string } }[] }[])[0].parts[1];
  assert.equal(part.inlineData?.mimeType, 'image/png', 'SVG plans are sent to Gemini as PNG');
});

test('the factory reports Gemini as not configured when there is no key', () => {
  const factory = new AnalyzerFactory([new GeminiAnalyzer(new GeminiPlanReader(new GeminiClient('')))]);
  assert.deepEqual(factory.list(), [{ provider: 'gemini', name: 'Gemini + visión geométrica', configured: false }]);
});

// ---------- Copilot ----------

test('the copilot only keeps proposals on real elements and editable fields', () => {
  const clean = AssistantService.sanitize(
    {
      answer: 'Puedes subir los muros.',
      proposals: [
        {
          title: 'Subir muros',
          reason: 'Doble altura',
          operations: [
            { op: 'update', elementId: 1, field: 'height', value: 3 },
            { op: 'update', elementId: 99, field: 'height', value: 3 },
            { op: 'update', elementId: 1, field: 'startX' as 'height', value: 3 },
            { op: 'update', elementId: 2, field: 'height', value: 9000 },
            { op: 'delete', elementId: 2 },
          ],
        },
        { title: 'Vacía', reason: 'x', operations: [{ op: 'delete', elementId: 77 }] },
      ],
    },
    new Set([1, 2]),
  );
  assert.equal(clean.proposals.length, 1);
  assert.deepEqual(clean.proposals[0].operations, [
    { op: 'update', elementId: 1, field: 'height', value: 3 },
    { op: 'delete', elementId: 2 },
  ]);
});

test('the copilot validates the question, sends the context and picks the deep model on request', async () => {
  const { calls, client } = fakeGemini([{ answer: 'Hay 1 muro.', proposals: [] }, { answer: 'ok', proposals: [] }]);
  const service = new AssistantService(client, { fast: 'gemini-3.8-flash', deep: 'gemini-3.1-pro-preview' });
  await assert.rejects(service.ask({ question: '  ', context: {} }), /Escribe una pregunta/);
  await assert.rejects(service.ask({ question: 'hola' }), /contexto/);
  const answer = await service.ask({
    question: '¿Cuántos muros hay?',
    context: { elements: [{ id: 1, type: 'Muro' }] },
    history: [{ role: 'model', text: 'Hola' }],
  });
  assert.equal(answer.answer, 'Hay 1 muro.');
  assert.match(String(calls[0].config?.systemInstruction), /NSR-10/);
  assert.equal((calls[0].contents as unknown[]).length, 2);
  assert.equal(calls[0].model, 'gemini-3.8-flash');
  await service.ask({ question: 'Analiza a fondo', context: { elements: [] }, depth: 'deep' });
  assert.equal(calls[1].model, 'gemini-3.1-pro-preview');
});

// ---------- AI renders ----------

test('renders are off without an image model and validate the capture', async () => {
  await assert.rejects(new RenderService(fakeGemini([]).client, '').render({ style: 'modern', image: PNG_1PX }), /no están habilitados/);
  const service = new RenderService(fakeGemini(['image']).client, 'gemini-3.1-flash-image');
  await assert.rejects(service.render({ style: 'gotico', image: PNG_1PX }), /Elige un estilo/);
  await assert.rejects(service.render({ style: 'modern', image: Buffer.from('hola').toString('base64') }), /PNG o JPEG/);
});

test('a render keeps the geometry in the prompt and returns the image with a disclaimer', async () => {
  const { calls, client } = fakeGemini(['image']);
  const result = await new RenderService(client, 'gemini-3.1-flash-image').render({
    style: 'tropical',
    image: `data:image/png;base64,${PNG_1PX}`,
  });
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.disclaimer, /No es un plano constructivo/);
  const parts = (calls[0].contents as { parts: { text?: string }[] }[])[0].parts;
  assert.match(String(parts[0].text), /Conserva exactamente la geometría/);
  assert.deepEqual(calls[0].config?.responseModalities, ['TEXT', 'IMAGE']);
});
