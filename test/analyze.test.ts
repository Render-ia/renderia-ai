import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { LocalVisionAnalyzer } from '../src/analyzers/LocalVisionAnalyzer.ts';
import { SampleAnalyzer } from '../src/analyzers/SampleAnalyzer.ts';

const samplePath = new URL('../../samples/plano-casa.svg', import.meta.url);

function count(elements: { type: string }[], type: string): number {
  return elements.filter((e) => e.type === type).length;
}

test('el detector de visión encuentra los elementos de la casa de ejemplo', async () => {
  const image = await readFile(samplePath);
  const { elements } = await new LocalVisionAnalyzer().analyze({ image, scale: '1:100', modelIdentifier: 'renderia-vision-v1' });

  assert.equal(count(elements, 'Muro'), 18);
  assert.equal(count(elements, 'Columna'), 11);
  assert.equal(count(elements, 'Puerta'), 6);
  assert.equal(count(elements, 'Ventana'), 5);
  assert.equal(count(elements, 'Viga'), 15);
  assert.equal(count(elements, 'Losa'), 1);
});

test('el detector rechaza un plano en blanco', async () => {
  const blank = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#fff"/></svg>');
  await assert.rejects(
    new LocalVisionAnalyzer().analyze({ image: blank, scale: '1:100', modelIdentifier: 'x' }),
    /en blanco/,
  );
});

test('la respuesta de ejemplo devuelve siempre la casa de ejemplo', async () => {
  const { elements } = await new SampleAnalyzer().analyze({ image: Buffer.alloc(0), scale: '1:100', modelIdentifier: 'mock-v1' });
  assert.equal(elements.length, 56);
});

test('POST /analyze descarga la imagen y devuelve los elementos', async () => {
  const svg = await readFile(samplePath);
  const images = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(svg);
  });
  await new Promise<void>((resolve) => images.listen(0, resolve));
  const imagesPort = (images.address() as AddressInfo).port;

  process.env.IMAGE_URL_PREFIXES = `http://127.0.0.1:${imagesPort}/`;
  const { server } = await import('../src/server.ts');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const ok = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: `http://127.0.0.1:${imagesPort}/plano.svg`, scale: '1:100', provider: 'local-vision' }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { elements: unknown[]; provider: string };
    assert.equal(body.provider, 'local-vision');
    assert.equal(body.elements.length, 56);

    const foreign = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: 'https://example.com/plano.png', scale: '1:100', provider: 'local-vision' }),
    });
    assert.equal(foreign.status, 400);

    const unknown = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: `http://127.0.0.1:${imagesPort}/plano.svg`, scale: '1:100', provider: 'no-existe' }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    server.close();
    images.close();
  }
});
