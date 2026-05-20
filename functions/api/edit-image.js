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
          error: 'Worker exception: ' + (e.message || String(e)),
        });
        const origin = new URL(context.request.url).origin;
        await sendTelegramIfComplete(context.env, batchId, origin);
      }
    } catch {}
    const msg = (e && e.message) ? e.message : String(e);
    return json({
      error: 'Worker exception: ' + msg.slice(0, 500),
      detail: detail.slice(0, 2000),
    }, 500);
  }
}

async function handle(context) {
  const { request, env, waitUntil } = context;
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

  await updateItem(env, batchId, name, {
    status: 'proc',
    originalKey,
    originalFilename,
    filename,
    resultKey,
    error: null,
    backgroundStartedAt: new Date().toISOString(),
  });

  // Run OpenAI + result store + notify in the background so the kickoff
  // returns in ~1s. With Smart Placement enabled (wrangler.toml), the
  // OpenAI subrequest completes in ~50–80s, well inside waitUntil's
  // budget. Client polls /api/batch?id=… to discover completion.
  waitUntil(processInBackground({
    env, origin, batchId, name, imageBytes, prompt,
    originalKey, originalFilename, filename, resultKey,
  }));

  return json({
    ok: true,
    pending: true,
    url: `/img/${batchId}/${filename}`,
    originalUrl: `/img/${batchId}/originals/${originalFilename}`,
  });
}

async function processInBackground({ env, origin, batchId, name, imageBytes, prompt, originalKey, originalFilename, filename, resultKey }) {
  try {
    const openaiForm = new FormData();
    openaiForm.append('model', 'gpt-image-2');
    openaiForm.append('image[]', new Blob([imageBytes], { type: 'image/png' }), 'image.png');
    openaiForm.append('prompt', String(prompt).slice(0, 32000));
    openaiForm.append('n', '1');
    openaiForm.append('size', '1920x1280');
    openaiForm.append('quality', 'high');

    const openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
      body: openaiForm,
    });

    const text = await openaiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      await updateItem(env, batchId, name, {
        status: 'err',
        error: 'Invalid OpenAI response (HTTP ' + openaiRes.status + '): ' + text.slice(0, 300),
      });
      await sendTelegramIfComplete(env, batchId, origin);
      return;
    }

    if (data.error) {
      await updateItem(env, batchId, name, {
        status: 'err',
        error: data.error.message,
      });
      await sendTelegramIfComplete(env, batchId, origin);
      return;
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      await updateItem(env, batchId, name, {
        status: 'err',
        error: 'No image in response',
      });
      await sendTelegramIfComplete(env, batchId, origin);
      return;
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
  } catch (e) {
    try {
      await updateItem(env, batchId, name, {
        status: 'err',
        error: 'Background: ' + (e.message || String(e)),
      });
      await sendTelegramIfComplete(env, batchId, origin);
    } catch {}
  }
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
