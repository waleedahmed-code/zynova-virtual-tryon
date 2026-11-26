/**
 * Zynova Virtual Try-On — multi-client Cloudflare Worker
 *
 * Flow:
 *   Shopify product page (zy-virtual-tryon section)
 *     → POST /tryon  { clientId, category, subtype, productTitle, person, product }
 *     → this Worker checks client + origin + limits, builds the prompt
 *     → Gemini image model (key stays here, never in the theme)
 *     → Gemini JSON is streamed straight back to the browser (keeps Worker CPU tiny,
 *       so it stays inside the free plan's CPU limit)
 *
 * Providers:
 *   "workers-ai" (default, FREE tier: 10,000 neurons/day) — Cloudflare FLUX.2 [klein] via the AI binding
 *   "gemini"     (paid, best quality)                      — needs GEMINI_API_KEY secret
 *   Both return the same JSON shape to the browser (candidates[].content.parts[].inlineData).
 *
 * Config (wrangler.toml / dashboard):
 *   PROVIDER         var      — "workers-ai" (default) or "gemini"; per client: CLIENTS.x.provider
 *   AI               binding  — Workers AI ([ai] binding = "AI")
 *   CF_MODEL         var      — optional, default @cf/black-forest-labs/flux-2-klein-4b
 *   GEMINI_API_KEY   secret   — only for provider "gemini": `wrangler secret put GEMINI_API_KEY`
 *   CLIENTS          var      — JSON, see wrangler.toml
 *   GEMINI_MODEL     var      — optional, default gemini-3.1-flash-image
 *   RATE_LIMITER     binding  — optional, per-IP limit (Workers Rate Limiting)
 *   USAGE            KV       — optional, per-client daily cap
 */

const DEFAULT_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_CF_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const CF_MAX_INPUT = 504; // Workers AI FLUX.2: input images must be smaller than 512x512
const GEMINI_MAX_INPUT = 1024;
const OUT_LONG_SIDE = 1024;
const MAX_B64_CHARS = 7 * 1024 * 1024; // ~5 MB binary per image
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const JEWELRY_SUBTYPES = {
  earrings: 'the earrings, placed naturally on both earlobes (or as a single earring if only one is shown)',
  necklace: 'the necklace / set, resting naturally around the neck and on the collarbone',
  ring: 'the ring, worn on a finger of a visible hand',
  bangles: 'the bangles / bracelet, worn on the wrist',
  nosepin: 'the nose pin / nath, placed on the nose',
  tikka: 'the maang tikka / matha patti, placed along the hair parting and forehead',
  watch: 'the watch, worn on the wrist',
  anklet: 'the anklet / payal, worn on the ankle',
  jewelry: 'the jewellery piece, placed where it is normally worn',
};

/* ---------------------------------------------------------------- helpers */

function parseClients(env) {
  try {
    return JSON.parse(env.CLIENTS || '{}');
  } catch {
    return {};
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

function normaliseOrigin(o) {
  return String(o || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Find which client an Origin belongs to. Returns [clientId, cfg] or null. */
function clientForOrigin(clients, origin) {
  const o = normaliseOrigin(origin);
  if (!o) return null;
  for (const [id, cfg] of Object.entries(clients)) {
    const list = (cfg.origins || []).map(normaliseOrigin);
    if (list.includes(o)) return [id, cfg];
  }
  return null;
}

function cleanText(s, max) {
  return String(s || '')
    .replace(/[\r\n\t"\\<>{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validImage(img) {
  if (!img || typeof img !== 'object') return 'missing';
  if (!ALLOWED_MIME.includes(img.mime)) return 'bad type';
  if (typeof img.data !== 'string' || img.data.length < 100) return 'empty';
  if (img.data.length > MAX_B64_CHARS) return 'too large';
  if (!B64_RE.test(img.data)) return 'not base64';
  return null;
}

function todayKey(clientId) {
  return `${clientId}:${new Date().toISOString().slice(0, 10)}`;
}

function providerFor(env, clientCfg) {
  const p = String((clientCfg && clientCfg.provider) || env.PROVIDER || 'workers-ai').toLowerCase();
  return p === 'gemini' ? 'gemini' : 'workers-ai';
}

/** Output size: keep the customer photo's aspect ratio, long side OUT_LONG_SIDE, multiples of 16, 256..1920 */
export function outputDims(w, h) {
  w = Number(w) || 768; h = Number(h) || 1024;
  const s = OUT_LONG_SIDE / Math.max(w, h);
  const fit = (v) => Math.min(1920, Math.max(256, Math.round((v * s) / 16) * 16));
  return { width: fit(w), height: fit(h) };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sniffMime(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

/* ----------------------------------------------------------------- prompt */

/**
 * Prompt for FLUX.2 [klein] (images referred to by index: image 0 = customer, image 1 = product).
 * Written as an EDIT instruction (not "a photo of...") so the model keeps image 0 and only swaps the
 * garment, and explicitly forbids copying the product model's face, pose, hands, bag or jewellery.
 */
export function buildFluxPrompt({ category, subtype, productTitle, clientCfg }) {
  const t = cleanText(productTitle, 120);
  const title = t ? ` (${t})` : '';
  const extra = clientCfg && clientCfg.promptNote ? ' ' + cleanText(clientCfg.promptNote, 300) : '';
  const keep =
    'Everything else in image 0 must stay exactly the same: the same face, eyes, nose, lips, expression, skin tone, ' +
    'hair, body shape, pose, arms, hands, camera angle, framing, background and lighting. ' +
    'The person keeps exactly two arms and two hands in their original position.';
  if (category === 'jewelry') {
    const what = JEWELRY_SUBTYPES[subtype] || JEWELRY_SUBTYPES.jewelry;
    return (
      `Edit image 0. Add only ${what} shown in image 1${title} to the person in image 0. ` +
      'Copy the jewellery exactly: same design, metal colour, stones and details, at a realistic size. ' +
      'Do not change the clothes. Do not copy any person, face, hair, hands or other items from image 1. ' +
      keep + ' Photorealistic, single photo, no text.' + extra
    );
  }
  return (
    `Edit image 0. Change only the clothes of the person in image 0: dress them in the outfit shown in image 1${title}. ` +
    'Copy the garment faithfully: same fabric, colours, print, embroidery, neckline, buttons, sleeves and length; ' +
    'add the matching dupatta and trousers if image 1 shows them. Keep it as modest as in image 1. ' +
    'Use image 1 only as a reference for the garment: do not copy the model, face, hair, pose, hands, ' +
    'handbag, bag, purse, clutch, jewellery, earrings, shoes or any accessories from image 1. ' +
    keep + ' Photorealistic, natural fabric folds, single photo, no text.' + extra
  );
}

export function buildPrompt({ category, subtype, productTitle, clientCfg }) {
  const t = cleanText(productTitle, 120);
  const title = t ? ` ("${t}")` : '';
  const keep =
    "Keep the person from IMAGE 1 exactly the same: same face, identity, facial features, skin tone, " +
    'hair, body shape, height, pose, expression, camera angle, lighting and background. ' +
    'Do NOT use the face, body or hair of any model shown in IMAGE 2.';
  const quality =
    'Result must be one photorealistic photo, natural lighting and shadows, correct scale, ' +
    'no text, no watermark, no collage, no side-by-side.';
  const extra = clientCfg && clientCfg.promptNote ? ' ' + cleanText(clientCfg.promptNote, 300) : '';

  if (category === 'jewelry') {
    const what = JEWELRY_SUBTYPES[subtype] || JEWELRY_SUBTYPES.jewelry;
    return (
      'IMAGE 1 is a customer photo. IMAGE 2 is a product photo of a jewellery item' + title + '. ' +
      `Edit IMAGE 1 so the customer is wearing ${what}. ` +
      'Copy the jewellery exactly from IMAGE 2: same design, metal colour, stones, size proportions and details. ' +
      'Change nothing else about the customer\'s clothes. ' +
      keep + ' ' + quality + extra
    );
  }

  return (
    'IMAGE 1 is a customer photo. IMAGE 2 is a product photo of a clothing item / outfit' + title +
    ' (it may be shown on a model, on a mannequin or laid flat). ' +
    'Edit IMAGE 1 so the customer is wearing exactly this outfit. ' +
    'Copy the garment faithfully: same fabric, colours, print, embroidery, neckline, sleeves, length, cut and fit. ' +
    'If IMAGE 2 includes a dupatta, shawl, trousers or other pieces of the outfit, include them styled the same way. ' +
    'Keep the outfit as modest as it is in IMAGE 2. Remove the customer\'s original clothing where it is replaced. ' +
    keep + ' ' + quality + extra
  );
}

/* ---------------------------------------------------------------- handler */

async function handleTryOn(request, env, origin, clientId, clientCfg) {
  // Per-IP rate limit (optional binding)
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `${clientId}:${ip}` });
    if (!success) return json(429, { error: 'Too many tries. Please wait a minute and try again.' }, origin);
  }

  // Per-client daily cap (optional KV)
  let used = 0;
  const cap = Number(clientCfg.dailyLimit || 0);
  if (env.USAGE && cap > 0) {
    used = Number((await env.USAGE.get(todayKey(clientId))) || 0);
    if (used >= cap) return json(429, { error: 'Try-on is busy today. Please try again tomorrow.' }, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid request.' }, origin);
  }

  if (body.clientId && body.clientId !== clientId) return json(403, { error: 'Client mismatch.' }, origin);

  const pErr = validImage(body.person);
  if (pErr) return json(400, { error: `Your photo could not be read (${pErr}).` }, origin);
  const prErr = validImage(body.product);
  if (prErr) return json(400, { error: `Product image could not be read (${prErr}).` }, origin);

  const category = body.category === 'jewelry' ? 'jewelry' : 'clothing';
  const subtype = JEWELRY_SUBTYPES[body.subtype] ? body.subtype : 'jewelry';
  const prompt = buildPrompt({
    category,
    subtype,
    productTitle: cleanText(body.productTitle, 120),
    clientCfg,
  });

  const provider = providerFor(env, clientCfg);
  const countUsage = async () => {
    if (env.USAGE && cap > 0) {
      const write = env.USAGE.put(todayKey(clientId), String(used + 1), { expirationTtl: 60 * 60 * 48 });
      if (request.ctx && request.ctx.waitUntil) request.ctx.waitUntil(write);
      else await write;
    }
  };

  if (provider === 'workers-ai') {
    return runWorkersAI({ env, body, category, subtype, clientCfg, origin, countUsage });
  }
  return runGemini({ env, body, prompt, clientCfg, origin, countUsage });
}

/* ------------------------------------------------------------ Workers AI */

async function runWorkersAI({ env, body, category, subtype, clientCfg, origin, countUsage }) {
  if (!env.AI) return json(500, { error: 'Try-on is not configured (AI binding missing).' }, origin);
  const model = clientCfg.cfModel || env.CF_MODEL || DEFAULT_CF_MODEL;
  const prompt = buildFluxPrompt({ category, subtype, productTitle: body.productTitle, clientCfg });
  const dims = outputDims(body.person.w, body.person.h);

  const fd = new FormData();
  fd.append('prompt', prompt);
  fd.append('input_image_0', new Blob([b64ToBytes(body.person.data)], { type: body.person.mime }), 'person.jpg');
  fd.append('input_image_1', new Blob([b64ToBytes(body.product.data)], { type: body.product.mime }), 'product.jpg');
  fd.append('width', String(dims.width));
  fd.append('height', String(dims.height));
  // FormData doesn't expose its boundary; wrapping it in a Response does (per Cloudflare docs).
  const wrapped = new Response(fd);

  let out;
  try {
    out = await env.AI.run(model, {
      multipart: { body: wrapped.body, contentType: wrapped.headers.get('content-type') },
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.log('workers-ai error', msg);
    if (/4006|neurons|daily free allocation|capacity|rate limit|429/i.test(msg)) {
      return json(429, { error: 'Try-on has reached today\'s limit. Please try again tomorrow.', code: 'AI_LIMIT' }, origin);
    }
    if (/nsfw|safety|moderat|flagged/i.test(msg)) {
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return json(502, { error: 'AI service error. Please try again.', code: 'AI_ERROR' }, origin);
  }

  const img = out && typeof out.image === 'string' ? out.image : null;
  if (!img) {
    console.log('workers-ai: no image in response', out && Object.keys(out));
    return json(502, { error: 'AI service returned no image. Please try again.', code: 'AI_EMPTY' }, origin);
  }
  await countUsage();

  // Same shape as Gemini so the storefront code handles both. Concatenated to avoid re-serialising ~1MB.
  const payload =
    '{"provider":"workers-ai","candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"' +
    sniffMime(img) + '","data":"' + img + '"}}]}}]}';
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

/* ---------------------------------------------------------------- Gemini */

async function runGemini({ env, body, prompt, clientCfg, origin, countUsage }) {
  if (!env.GEMINI_API_KEY) return json(500, { error: 'Try-on is not configured (GEMINI_API_KEY missing).' }, origin);
  const model = clientCfg.model || env.GEMINI_MODEL || DEFAULT_MODEL;
  const base = (env.GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Built by string concatenation on purpose: avoids re-serialising two large base64 strings.
  const payload =
    '{"contents":[{"role":"user","parts":[' +
    JSON.stringify({ text: prompt }) + ',' +
    JSON.stringify({ text: 'IMAGE 1 (customer):' }) + ',' +
    '{"inline_data":{"mime_type":"' + body.person.mime + '","data":"' + body.person.data + '"}},' +
    JSON.stringify({ text: 'IMAGE 2 (product):' }) + ',' +
    '{"inline_data":{"mime_type":"' + body.product.mime + '","data":"' + body.product.data + '"}}' +
    ']}],"generationConfig":{"responseModalities":["TEXT","IMAGE"]}}';

  let gRes;
  try {
    gRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: payload,
    });
  } catch {
    return json(502, { error: 'AI service unreachable. Please try again.' }, origin);
  }

  if (!gRes.ok) {
    let detail = '';
    try {
      const e = await gRes.json();
      detail = (e && e.error && e.error.status) || '';
    } catch {}
    console.log('gemini error', gRes.status, detail);
    const status = gRes.status === 429 ? 429 : 502;
    const msg = gRes.status === 429 ? 'Try-on is busy right now. Please try again in a minute.' : 'AI service error. Please try again.';
    return json(status, { error: msg, code: detail || gRes.status }, origin);
  }

  await countUsage();

  // Stream Gemini's JSON straight through — the browser extracts the image.
  return new Response(gRes.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const clients = parseClients(env);
    const match = clientForOrigin(clients, origin);

    if (url.pathname === '/health') {
      const provider = providerFor(env, null);
      return json(200, {
        ok: true,
        clients: Object.keys(clients).length,
        provider,
        aiBinding: !!env.AI,
        geminiKey: !!env.GEMINI_API_KEY,
      });
    }

    if (url.pathname !== '/tryon' && url.pathname !== '/config') return json(404, { error: 'Not found' }, match ? origin : '');

    if (!match) return json(403, { error: 'This store is not enabled for try-on.' });
    const [clientId, clientCfg] = match;
    if (clientCfg.enabled === false) return json(403, { error: 'Try-on is disabled for this store.' }, origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === '/config') {
      const provider = providerFor(env, clientCfg);
      // productCropTop: fraction of the product photo's top to cut off before sending (removes the
      // product model's head so the AI can't copy her face). Only applied to clothing by the storefront.
      const crop = Math.min(0.4, Math.max(0, Number(clientCfg.productCropTop) || 0));
      return json(200, { provider, maxInput: provider === 'gemini' ? GEMINI_MAX_INPUT : CF_MAX_INPUT, productCropTop: crop }, origin);
    }

    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, origin);

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > 2 * MAX_B64_CHARS + 20000) return json(413, { error: 'Images are too large.' }, origin);

    request.ctx = ctx;
    try {
      return await handleTryOn(request, env, origin, clientId, clientCfg);
    } catch (err) {
      console.log('unhandled', err && err.message);
      return json(500, { error: 'Something went wrong. Please try again.' }, origin);
    }
  },
};
