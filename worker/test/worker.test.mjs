import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildPrompt } from '../src/index.js';

const ORIGIN = 'https://miacara.pk';
const B64 = Buffer.alloc(600, 7).toString('base64');
const IMG = { mime: 'image/jpeg', data: B64 };

function makeEnv(over = {}) {
  const store = new Map();
  return {
    GEMINI_API_KEY: 'test-key',
    CLIENTS: JSON.stringify({
      miacara: { origins: ['https://miacara.pk', 'https://www.miacara.pk/'], dailyLimit: 2 },
      off: { origins: ['https://off.com'], enabled: false },
    }),
    USAGE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v), _store: store },
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...over,
  };
}

function req(body, { origin = ORIGIN, method = 'POST', path = '/tryon' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request('https://w.example' + path, {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

const okBody = { clientId: 'miacara', category: 'clothing', productTitle: 'Lawn 3pc', person: IMG, product: IMG };

let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
});

test('health', async () => {
  const r = await worker.fetch(req(null, { method: 'GET', path: '/health' }), makeEnv());
  assert.equal(r.status, 200);
});

test('unknown origin is rejected', async () => {
  const r = await worker.fetch(req(okBody, { origin: 'https://evil.com' }), makeEnv());
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('missing origin is rejected', async () => {
  const r = await worker.fetch(req(okBody, { origin: null }), makeEnv());
  assert.equal(r.status, 403);
});

test('disabled client rejected', async () => {
  const r = await worker.fetch(req(okBody, { origin: 'https://off.com' }), makeEnv());
  assert.equal(r.status, 403);
});

test('CORS preflight', async () => {
  const r = await worker.fetch(req(null, { method: 'OPTIONS' }), makeEnv());
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('trailing slash origin in config still matches', async () => {
  const r = await worker.fetch(req(okBody, { origin: 'https://www.miacara.pk' }), makeEnv());
  assert.equal(r.status, 200);
});

test('success: passes Gemini JSON through + sends both images + key header', async () => {
  const env = makeEnv();
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const j = await r.json();
  assert.equal(j.candidates[0].content.parts[0].inlineData.data, 'AAAA');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.1-flash-image:generateContent$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  const sent = JSON.parse(calls[0].init.body); // payload must be valid JSON
  const parts = sent.contents[0].parts;
  assert.equal(parts.filter((p) => p.inline_data).length, 2);
  assert.match(parts[0].text, /clothing item/);
  assert.deepEqual(sent.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal([...env.USAGE._store.values()][0], '1');
});

test('jewelry prompt uses subtype', async () => {
  await worker.fetch(req({ ...okBody, category: 'jewelry', subtype: 'earrings' }), makeEnv());
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.contents[0].parts[0].text, /earlobes/);
});

test('unknown subtype falls back to generic jewellery', () => {
  const p = buildPrompt({ category: 'jewelry', subtype: 'xx' });
  assert.match(p, /jewellery piece/);
});

test('bad base64 / mime / missing images rejected without calling Gemini', async () => {
  for (const person of [null, { mime: 'image/gif', data: B64 }, { mime: 'image/jpeg', data: 'x'.repeat(200) + '"}' }, { mime: 'image/jpeg', data: 'abc' }]) {
    const r = await worker.fetch(req({ ...okBody, person }), makeEnv());
    assert.equal(r.status, 400, JSON.stringify(person)?.slice(0, 40));
  }
  assert.equal(calls.length, 0);
});

test('injection attempt in mime is blocked', async () => {
  const r = await worker.fetch(req({ ...okBody, product: { mime: 'image/jpeg","x":"', data: B64 } }), makeEnv());
  assert.equal(r.status, 400);
});

test('product title cannot break prompt', () => {
  const p = buildPrompt({ category: 'clothing', productTitle: 'a"\nb' });
  assert.ok(!p.includes('\n'));
});

test('invalid JSON body', async () => {
  const r = await worker.fetch(req('{nope'), makeEnv());
  assert.equal(r.status, 400);
});

test('clientId mismatch', async () => {
  const r = await worker.fetch(req({ ...okBody, clientId: 'other' }), makeEnv());
  assert.equal(r.status, 403);
});

test('daily cap enforced', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req(okBody), env)).status, 200);
  assert.equal((await worker.fetch(req(okBody), env)).status, 200);
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 429);
  assert.equal(calls.length, 2);
});

test('rate limiter enforced', async () => {
  const r = await worker.fetch(req(okBody), makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(r.status, 429);
  assert.equal(calls.length, 0);
});

test('works without optional bindings', async () => {
  const r = await worker.fetch(req(okBody), makeEnv({ USAGE: undefined, RATE_LIMITER: undefined }));
  assert.equal(r.status, 200);
});

test('missing API key', async () => {
  const r = await worker.fetch(req(okBody), makeEnv({ GEMINI_API_KEY: '' }));
  assert.equal(r.status, 500);
});

test('Gemini error mapped, not counted', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'secret details' } }), { status: 400 });
  const env = makeEnv();
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.code, 'INVALID_ARGUMENT');
  assert.ok(!JSON.stringify(j).includes('secret details'));
  assert.equal(env.USAGE._store.size, 0);
});

test('Gemini 429 -> 429', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  const r = await worker.fetch(req(okBody), makeEnv());
  assert.equal(r.status, 429);
});

test('network failure -> 502', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  const r = await worker.fetch(req(okBody), makeEnv());
  assert.equal(r.status, 502);
});

test('per-client model override', async () => {
  const env = makeEnv({ CLIENTS: JSON.stringify({ m: { origins: [ORIGIN], model: 'gemini-3.1-flash-lite-image' } }) });
  await worker.fetch(req({ ...okBody, clientId: 'm' }), env);
  assert.match(calls[0].url, /flash-lite-image/);
});
