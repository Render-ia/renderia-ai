import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { scaleDenominator } from '../src/scale.ts';

// Each test file runs in its own process, so this key only applies here.
process.env.AI_API_KEY = 'clave-de-prueba';

let base = '';
let imagesBase = '';
let close: () => void = () => {};

before(async () => {
  // Fake backend that serves a text file pretending to be an image.
  const images = createServer((req, res) => {
    if (req.url === '/not-an-image') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h1>hola</h1>');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => images.listen(0, resolve));
  imagesBase = `http://127.0.0.1:${(images.address() as AddressInfo).port}`;
  process.env.IMAGE_URL_PREFIXES = `${imagesBase}/`;

  const { server } = await import('../src/server.ts');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    images.close();
  };
});

after(() => close());

function analyze(body: unknown, key = 'clave-de-prueba'): Promise<Response> {
  return fetch(`${base}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('health and model list are public', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const models = await fetch(`${base}/models`);
  assert.equal(models.status, 200);
});

test('analyze rejects a missing or wrong API key', async () => {
  const response = await analyze({ imageUrl: `${imagesBase}/x.png`, scale: '1:100', provider: 'local-vision' }, 'otra');
  assert.equal(response.status, 401);
});

test('analyze rejects invalid JSON and missing fields', async () => {
  assert.equal((await analyze('{esto no es json')).status, 400);
  assert.equal((await analyze({ scale: '1:100', provider: 'local-vision' })).status, 400);
  assert.equal((await analyze([1, 2, 3])).status, 400);
});

test('analyze rejects a scale that is not 1:N', async () => {
  const response = await analyze({ imageUrl: `${imagesBase}/x.png`, scale: 'cien', provider: 'local-vision' });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { message: string };
  assert.match(body.message, /escala/i);
});

test('analyze rejects files that are not images and plans that do not exist', async () => {
  const notImage = await analyze({ imageUrl: `${imagesBase}/not-an-image`, scale: '1:100', provider: 'local-vision' });
  assert.equal(notImage.status, 400);
  const missing = await analyze({ imageUrl: `${imagesBase}/missing.png`, scale: '1:100', provider: 'local-vision' });
  assert.equal(missing.status, 400);
});

test('unknown routes answer 404 in JSON', async () => {
  const response = await fetch(`${base}/admin`);
  assert.equal(response.status, 404);
  assert.ok(((await response.json()) as { message: string }).message);
});

test('scale parser accepts common spellings and rejects nonsense', () => {
  assert.equal(scaleDenominator('1:100'), 100);
  assert.equal(scaleDenominator(' 1 : 50 '), 50);
  assert.equal(scaleDenominator('1:12,5'), 12.5);
  assert.throws(() => scaleDenominator('1:0'));
  assert.throws(() => scaleDenominator('100'));
});
