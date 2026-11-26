import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildPrompt, buildFluxPrompt, outputDims } from '../src/index.js';

const ORIGIN = 'https://miacara.pk';
const B64 = Buffer.alloc(600, 7).toString('base64');
const IMG = { mime: 'image/jpeg', data: B64, w: 378, h: 504 };

function makeEnv(over = {}) {
  const store = new Map();
  return {
    GEMINI_API_KEY: 'test-key',
    PROVIDER: 'gemini',
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


/* ------------------------------------------------------- Workers AI provider */

function aiEnv(over = {}) {
  const calls = [];
  const env = makeEnv({
    PROVIDER: undefined,
    GEMINI_API_KEY: undefined,
    AI: {
      run: async (model, input) => {
        const form = await new Response(input.multipart.body, { headers: { 'content-type': input.multipart.contentType } }).formData();
        calls.push({ model, form });
        if (over.aiThrow) throw new Error(over.aiThrow);
        return over.aiOut !== undefined ? over.aiOut : { image: '/9j/RESULTJPEG' };
      },
    },
    ...over.env,
  });
  return { env, calls };
}

test('default provider is workers-ai, works without GEMINI key', async () => {
  const { env, calls } = aiEnv();
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.candidates[0].content.parts[0].inlineData.data, '/9j/RESULTJPEG');
  assert.equal(j.candidates[0].content.parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, '@cf/black-forest-labs/flux-2-klein-4b');
  const f = calls[0].form;
  assert.match(f.get('prompt'), /^Edit image 0\. Change only the clothes/);
  assert.match(f.get('prompt'), /Do not copy any person, face, hair, hands, pose, handbag, bag/);
  assert.match(f.get('prompt'), /exactly two arms and two hands/);
  const p0 = f.get('input_image_0'), p1 = f.get('input_image_1');
  assert.equal(p0.size, 600); assert.equal(p1.size, 600);
  assert.equal(p0.type, 'image/jpeg');
  // 378x504 portrait -> 768x1024
  assert.equal(f.get('width'), '768'); assert.equal(f.get('height'), '1024');
  assert.equal([...env.USAGE._store.values()][0], '1');
});

test('workers-ai jewelry prompt', async () => {
  const { env, calls } = aiEnv();
  await worker.fetch(req({ ...okBody, category: 'jewelry', subtype: 'necklace' }), env);
  assert.match(calls[0].form.get('prompt'), /around the neck/);
});

test('workers-ai quota error -> 429 friendly, not counted', async () => {
  const { env } = aiEnv({ aiThrow: 'AiError: 4006: you have used up your daily free allocation of 10,000 neurons' });
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /today/);
  assert.equal(env.USAGE._store.size, 0);
});

test('workers-ai safety error -> IMAGE_SAFETY shape', async () => {
  const { env } = aiEnv({ aiThrow: 'NSFW content detected' });
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).candidates[0].finishReason, 'IMAGE_SAFETY');
});

test('workers-ai generic error -> 502', async () => {
  const { env } = aiEnv({ aiThrow: 'boom' });
  assert.equal((await worker.fetch(req(okBody), env)).status, 502);
});

test('workers-ai empty output -> 502', async () => {
  const { env } = aiEnv({ aiOut: {} });
  assert.equal((await worker.fetch(req(okBody), env)).status, 502);
});

test('workers-ai missing binding -> clear 500 message', async () => {
  const { env } = aiEnv({ env: { AI: undefined } });
  const r = await worker.fetch(req(okBody), env);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /AI binding/);
});

test('gemini provider without key -> clear 500 message', async () => {
  const r = await worker.fetch(req(okBody), makeEnv({ GEMINI_API_KEY: '' }));
  assert.match((await r.json()).error, /GEMINI_API_KEY/);
});

test('per-client provider override to gemini', async () => {
  const { env, calls } = aiEnv({ env: { GEMINI_API_KEY: 'k', CLIENTS: JSON.stringify({ m: { origins: [ORIGIN], provider: 'gemini' } }) } });
  const r = await worker.fetch(req({ ...okBody, clientId: 'm' }), env);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0); // Workers AI not used
});

test('/config returns provider + max input size with CORS', async () => {
  const { env } = aiEnv();
  const r = await worker.fetch(req(null, { method: 'GET', path: '/config' }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await r.json(), { provider: 'workers-ai', maxInput: 504, productCropTop: 0 });
  const g = await worker.fetch(req(null, { method: 'GET', path: '/config' }), makeEnv());
  assert.deepEqual(await g.json(), { provider: 'gemini', maxInput: 1024, productCropTop: 0 });
  const c = await worker.fetch(req(null, { method: 'GET', path: '/config' }),
    makeEnv({ CLIENTS: JSON.stringify({ m: { origins: [ORIGIN], productCropTop: 0.9 } }) }));
  assert.equal((await c.json()).productCropTop, 0.4); // clamped
});

test('/config blocked for unknown origin', async () => {
  const { env } = aiEnv();
  assert.equal((await worker.fetch(req(null, { method: 'GET', path: '/config', origin: 'https://evil.com' }), env)).status, 403);
});

test('/health reports provider + binding status', async () => {
  const { env } = aiEnv();
  const j = await (await worker.fetch(req(null, { method: 'GET', path: '/health' }), env)).json();
  assert.equal(j.provider, 'workers-ai'); assert.equal(j.aiBinding, true); assert.equal(j.geminiKey, false);
});

test('outputDims', () => {
  assert.deepEqual(outputDims(504, 504), { width: 1024, height: 1024 });
  assert.deepEqual(outputDims(504, 378), { width: 1024, height: 768 });
  assert.deepEqual(outputDims(100, 2000), { width: 256, height: 1024 });
  assert.deepEqual(outputDims(undefined, undefined), { width: 768, height: 1024 });
});

test('flux prompt sanitises title', () => {
  assert.ok(!buildFluxPrompt({ category: 'clothing', productTitle: 'a"\nb' }).includes('\n'));
});

test('productMode garment adds cut-out line to FLUX prompt', async () => {
  const { env, calls } = aiEnv();
  await worker.fetch(req({ ...okBody, productMode: 'garment' }), env);
  assert.match(calls[0].form.get('prompt'), /face, hair, hands and bag were digitally removed/);
  const { env: env2, calls: calls2 } = aiEnv();
  await worker.fetch(req({ ...okBody, productMode: 'evil"injection' }), env2);
  assert.ok(!/digitally removed/.test(calls2[0].form.get('prompt')));
});

test('multiple product views -> input_image_1..3, extra views dropped', async () => {
  const { env, calls } = aiEnv();
  const views = [IMG, IMG, IMG, IMG, IMG];
  const r = await worker.fetch(req({ ...okBody, product: undefined, products: views }), env);
  assert.equal(r.status, 200);
  const f = calls[0].form;
  assert.ok(f.get('input_image_1') && f.get('input_image_2') && f.get('input_image_3'));
  assert.equal(f.get('input_image_4'), null);
  assert.match(f.get('prompt'), /images 1 to 3 \(different views of the same product\)/);
});

test('one bad product view -> 400, AI not called', async () => {
  const { env, calls } = aiEnv();
  const r = await worker.fetch(req({ ...okBody, products: [IMG, { mime: 'image/gif', data: B64 }] }), env);
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('dupatta yes/no + details reach the prompt (sanitised)', async () => {
  let { env, calls } = aiEnv();
  await worker.fetch(req({ ...okBody, dupatta: 'yes', details: 'Shirt length 44"\n<b>Lawn</b>' }), env);
  let pr = calls[0].form.get('prompt');
  assert.match(pr, /The outfit HAS a dupatta/);
  assert.match(pr, /Product details: Shirt length 44 b Lawn \/b/);
  assert.ok(!/[\n<>"]/.test(pr.split('Product details:')[1].split('.')[0]));
  ({ env, calls } = aiEnv());
  await worker.fetch(req({ ...okBody, dupatta: 'no' }), env);
  assert.match(calls[0].form.get('prompt'), /has NO dupatta: do not add any dupatta/);
  ({ env, calls } = aiEnv());
  await worker.fetch(req({ ...okBody, dupatta: 'maybe' }), env);
  assert.ok(!/dupatta: the person must|NO dupatta/.test(calls[0].form.get('prompt')));
});

test('gemini receives all product views in order', async () => {
  const r = await worker.fetch(req({ ...okBody, products: [IMG, IMG], dupatta: 'yes' }), makeEnv());
  assert.equal(r.status, 200);
  const sent = JSON.parse(calls[0].init.body);
  const parts = sent.contents[0].parts;
  assert.equal(parts.filter((p) => p.inline_data).length, 3);
  assert.ok(parts.some((p) => p.text === 'IMAGE 3 (product view 2):'));
  assert.match(parts[0].text, /IMAGES 2 to 3/);
  assert.match(parts[0].text, /HAS a dupatta/);
});
