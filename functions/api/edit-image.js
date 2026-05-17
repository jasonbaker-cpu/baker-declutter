import { sendTelegramIfComplete } from '../_lib/notify.js';

export async function onRequestPost({ request, env }) {
  const form = await request.formData();
  const image = form.get('image');
  const prompt = form.get('prompt');
  const batchId = form.get('batchId');
  const name = form.get('name');

  if (!image || !prompt || !batchId || !name) {
    return json({ error: 'missing fields (image, prompt, batchId, name required)' }, 400);
  }

  const origin = new URL(request.url).origin;

  const safeBase = String(name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const originalFilename = `${safeBase}.png`;
  const originalKey = `batches/${batchId}/originals/${originalFilename}`;
  const filename = `${safeBase}_decluttered.png`;
  const resultKey = `batches/${batchId}/${filename}`;

  const imageBytes = await image.arrayBuffer();

  await env.R2_BUCKET.put(originalKey, imageBytes, {
    httpMetadata: { contentType: 'image/png' },
  });

  const openaiForm = new FormData();
  openaiForm.append('model', 'gpt-image-2');
  openaiForm.append('image[]', new Blob([imageBytes], { type: 'image/png' }), 'image.png');
  openaiForm.append('prompt', String(prompt).slice(0, 999));
  openaiForm.append('n', '1');
  openaiForm.append('size', '1920x1280');
  openaiForm.append('quality', 'high');

  let openaiRes;
  try {
    openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
      body: openaiForm,
    });
  } catch (e) {
    await updateItem(env, batchId, name, { status: 'err', error: 'OpenAI fetch failed: ' + e.message, originalKey, originalFilename });
    await sendTelegramIfComplete(env, batchId, origin);
    return json({ error: 'OpenAI fetch failed', detail: e.message }, 502);
  }

  const text = await openaiRes.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    await updateItem(env, batchId, name, { status: 'err', error: 'Invalid OpenAI response', originalKey, originalFilename });
    await sendTelegramIfComplete(env, batchId, origin);
    return json({ error: 'Invalid OpenAI response', detail: text.slice(0, 500) }, 502);
  }

  if (data.error) {
    await updateItem(env, batchId, name, { status: 'err', error: data.error.message, originalKey, originalFilename });
    await sendTelegramIfComplete(env, batchId, origin);
    return json({ error: data.error.message }, 502);
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    await updateItem(env, batchId, name, { status: 'err', error: 'No image in response', originalKey, originalFilename });
    await sendTelegramIfComplete(env, batchId, origin);
    return json({ error: 'No image returned' }, 502);
  }

  const resultBytes = base64ToBytes(b64);

  await env.R2_BUCKET.put(resultKey, resultBytes, {
    httpMetadata: { contentType: 'image/png' },
  });

  await updateItem(env, batchId, name, {
    status: 'done',
    originalKey,
    originalFilename,
    resultKey,
    filename,
    error: null,
  });

  await sendTelegramIfComplete(env, batchId, origin);

  return json({
    ok: true,
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

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
