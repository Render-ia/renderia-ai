import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedImageUrl } from '../src/imageDownloader.ts';
import { publicMessage, UNREADABLE_IMAGE } from '../src/publicError.ts';

const prefixes = ['https://renderia-backend.onrender.com/'];

test('only plan images from the backend can be downloaded', () => {
  assert.equal(isAllowedImageUrl('https://renderia-backend.onrender.com/api/v1/floor-plans/3/image?exp=1&sig=a', prefixes), true);
  for (const url of [
    'https://renderia-backend.onrender.com.evil.example/x.png',
    'https://renderia-backend.onrender.com@evil.example/x.png',
    'https://user:pass@renderia-backend.onrender.com/x.png',
    'http://renderia-backend.onrender.com/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'gopher://renderia-backend.onrender.com/',
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedImageUrl(url, prefixes), false, url);
  }
});

test('the URL is normalized before it is compared', () => {
  assert.equal(isAllowedImageUrl('HTTPS://RENDERIA-BACKEND.ONRENDER.COM/api/v1/floor-plans/3/image', prefixes), true);
  assert.equal(isAllowedImageUrl('https://renderia-backend.onrender.com/a/../../x', prefixes), true);
});

test('image library internals never reach the user', () => {
  for (const internal of [
    'Input image exceeds pixel limit',
    'Input buffer has corrupt header: glib: XML parse error: Maximum entity amplification factor exceeded',
    'Input buffer contains unsupported image format',
    'VipsJpeg: Premature end of input file',
  ]) {
    assert.equal(publicMessage(new Error(internal)), UNREADABLE_IMAGE, internal);
  }
});

test('our own Spanish messages are kept for the user', () => {
  assert.equal(publicMessage(new Error('El plano parece estar en blanco.')), 'El plano parece estar en blanco.');
  assert.equal(publicMessage('raro'), 'Error inesperado al analizar el plano.');
  assert.ok(publicMessage(new Error('x'.repeat(1000))).length <= 301);
});
