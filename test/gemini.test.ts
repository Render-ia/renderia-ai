import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GeminiAnalyzer, type GeminiPlanReading } from '../src/analyzers/GeminiAnalyzer.ts';
import { AnalyzerFactory } from '../src/analyzers/AnalyzerFactory.ts';
import { AssistantService } from '../src/assistant/AssistantService.ts';
import { GeminiClient, GeminiError, type FetchLike } from '../src/gemini/GeminiClient.ts';

const samplePath = new URL('../../samples/house-floor-plan.svg', import.meta.url);

/** Fake Gemini endpoint: records the calls and answers with the given JSON text. */
function fakeGemini(answers: (object | number)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift() ?? 500;
    if (typeof next === 'number') return new Response('{}', { status: next });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, client: new GeminiClient('clave-de-prueba', fetchImpl, 'https://gemini.test/v1beta', 5000) };
}

const IMAGE = { width: 1000, height: 500, scale: '1:100', modelIdentifier: 'gemini-test', name: 'Gemini (visión)' };
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

test('Gemini answer becomes elements in meters with snapped walls', () => {
  const { elements, summary } = GeminiAnalyzer.toOutput(reading(), IMAGE);
  const wall = elements.find((e) => e.type === 'Muro')!;
  assert.equal(wall.startY, wall.endY, 'a wall 4/1000 off horizontal is snapped');
  assert.equal(wall.startX, 1.69);
  assert.equal(wall.endX, 15.24);
  assert.equal(wall.confidence, 0.92);
  assert.equal(elements.filter((e) => e.type === 'Puerta')[0].width, 0.85);
  assert.equal(elements.some((e) => (e.type as string) === 'Ascensor'), false, 'unknown types are dropped');
  assert.equal(elements.filter((e) => e.type === 'Losa').length, 1, 'a slab is added when none is drawn');
  const assumptions = summary.assumptions as { field: string; source: string }[];
  assert.ok(assumptions.some((a) => a.field === 'Altura de muros' && a.source === 'supuesto'));
  assert.ok(assumptions.some((a) => a.field === 'Losa' && a.source === 'supuesto'));
  assert.equal((summary.rooms as unknown[]).length, 1);
});

test('coordinates outside the image are clamped and never negative', () => {
  const { elements } = GeminiAnalyzer.toOutput(
    reading({ elements: [{ type: 'Muro', x1: -300, y1: 200, x2: 2000, y2: 200, confidence: 3 }] }),
    IMAGE,
  );
  const wall = elements[0];
  assert.equal(wall.startX, 0);
  assert.equal(wall.endX, 16.93);
  assert.equal(wall.confidence, 1);
});

test('an illegible plan or a plan without walls is rejected with a clear message', () => {
  assert.throws(() => GeminiAnalyzer.toOutput(reading({ legible: false, issues: ['borroso'] }), IMAGE), /borroso/);
  assert.throws(() => GeminiAnalyzer.toOutput(reading({ elements: [] }), IMAGE), /no encontró muros/);
});

test('a scale written on the plan that differs from the chosen one becomes a warning', () => {
  const { summary } = GeminiAnalyzer.toOutput(reading({ scaleText: '1:50' }), IMAGE);
  assert.match((summary.warnings as string[]).join(' '), /1:50/);
});

test('the client sends the key in a header, never in the URL, and retries once on 503', async () => {
  const { calls, client } = fakeGemini([503, { ok: true }]);
  const result = await client.generateJson<{ ok: boolean }>({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
    responseSchema: { type: 'OBJECT' },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent');
  assert.ok(!calls[0].url.includes('clave-de-prueba'));
  assert.equal((calls[0].init.headers as Record<string, string>)['x-goog-api-key'], 'clave-de-prueba');
});

test('the client explains a bad key and refuses odd model ids', async () => {
  const { client } = fakeGemini([403]);
  const request = { model: 'gemini-2.5-flash', contents: [], responseSchema: {} };
  await assert.rejects(client.generateJson(request), /clave de Gemini/);
  await assert.rejects(client.generateJson({ ...request, model: '../../otra-ruta' }), GeminiError);
  await assert.rejects(new GeminiClient('').generateJson(request), /GEMINI_API_KEY/);
});

test('the Gemini analyzer reads a real plan image end to end', async () => {
  const image = await readFile(samplePath);
  const { calls, client } = fakeGemini([reading()]);
  const { elements } = await new GeminiAnalyzer(client).analyze({ image, scale: '1:100', modelIdentifier: 'gemini-2.5-flash' });
  assert.ok(elements.length >= 3);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/png', 'SVG plans are sent as PNG');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('the factory lists Gemini as not configured when there is no key', () => {
  const factory = new AnalyzerFactory([new GeminiAnalyzer(new GeminiClient(''))]);
  assert.deepEqual(factory.list(), [{ provider: 'gemini', name: 'Gemini (visión)', configured: false }]);
});

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

test('the copilot validates the question and sends the context to Gemini', async () => {
  const { calls, client } = fakeGemini([{ answer: 'Hay 1 muro.', proposals: [] }]);
  const service = new AssistantService(client, 'gemini-2.5-flash');
  await assert.rejects(service.ask({ question: '  ', context: {} }), /Escribe una pregunta/);
  await assert.rejects(service.ask({ question: 'hola' }), /contexto/);
  const answer = await service.ask({
    question: '¿Cuántos muros hay?',
    context: { elements: [{ id: 1, type: 'Muro' }] },
    history: [{ role: 'model', text: 'Hola' }],
  });
  assert.equal(answer.answer, 'Hay 1 muro.');
  const body = JSON.parse(String(calls[0].init.body));
  assert.match(body.system_instruction.parts[0].text, /NSR-10/);
  assert.equal(body.contents.length, 2);
});
