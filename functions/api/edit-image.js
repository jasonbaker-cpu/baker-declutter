// Pages Function for the producer side of the Queues flow.
//
// Stores the uploaded original to R2 (fast), enqueues a job describing
// the work, and returns immediately. A separate Worker (workers/consumer)
// pulls jobs off the queue and does the OpenAI image-edit with its own
// runtime budget — no waitUntil zombie behavior, with automatic retries.

import { sendTelegramIfComplete } from '../_lib/notify.js';

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    const detail = (e && (e.stack || e.message)) || String(e);
    try {
      const form = await context.request.clone().formData();
      const batchId = form.get('batchId');
      const name = form.get('name');
      if (batchId && name) {
        await updateItem(context.env, batchId, name, {
          status: 'err',
          error: 'Producer exception: ' + (e.message || String(e)),
        });
        const origin = new URL(context.request.url).origin;
        await sendTelegramIfComplete(context.env, batchId, origin);
      }
    } catch {}
    const msg = (e && e.message) ? e.message : String(e);
    return json({
      error: 'Producer exception: ' + msg.slice(0, 500),
      detail: detail.slice(0, 2000),
    }, 500);
  }
}

async function handle({ request, env }) {
  const form = await request.formData();
  const image = form.get('image');
  const prompt = form.get('prompt');
  const batchId = form.get('batchId');
  const name = form.get('name');

  if (!image || !prompt || !batchId || !name) {
    return json({ error: 'missing fields (image, prompt, batchId, name required)' }, 400);
  }

  if (!env.DECLUTTER_QUEUE) {
    return json({
      error: 'Queue binding DECLUTTER_QUEUE is missing on this Pages project',
    }, 500);
  }

  const origin = new URL(request.url).origin;

  const safeBase = String(name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const originalFilename = `${safeBase}.png`;
  const originalKey = `batches/${batchId}/originals/${originalFilename}`;
  const filename = `${safeBase}_decluttered.png`;
  const resultKey = `batches/${batchId}/${filename}`;

  const imageBytes = await image.arrayBuffer();

  // Store original to R2 synchronously so the consumer can read it back
  // by key. We don't pass image bytes through the queue (messages are
  // capped well below the size of a 5MB image and base64 would inflate).
  await env.R2_BUCKET.put(originalKey, imageBytes, {
    httpMetadata: { contentType: 'image/png' },
  });

  await updateItem(env, batchId, name, {
    status: 'proc',
    originalKey,
    originalFilename,
    filename,
    resultKey,
    error: null,
    queuedAt: new Date().toISOString(),
  });

  await env.DECLUTTER_QUEUE.send({
    batchId,
    name,
    prompt: String(prompt).slice(0, 32000),
    originalKey,
    originalFilename,
    filename,
    resultKey,
    origin,
  });

  return json({
    ok: true,
    queued: true,
    url: `/img/${batchId}/${filename}`,
    originalUrl: `/img/${batchId}/originals/${originalFilename}`,
  });
}

async function updateItem(env, batchId, name, updates) {
  const raw = await env.BATCHES.get(`batch:${batchId}`);
  if (!raw) return;
  const manifest = JSON.parse(raw);
  const item = manifest.items.find((i) => i.name === name);
  if (item) Object.assign(item, updates);
  await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
