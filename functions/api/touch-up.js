// Touch-up endpoint: re-runs Gemini on an already-processed result with
// a focused prompt (e.g. "remove the small box in the corner"). Uses the
// same queue + consumer Worker as the initial pass — the consumer reads
// sourceKey instead of originalKey when sourceKey is present.

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    const detail = (e && (e.stack || e.message)) || String(e);
    const msg = (e && e.message) ? e.message : String(e);
    return json({
      error: 'Touch-up exception: ' + msg.slice(0, 500),
      detail: detail.slice(0, 2000),
    }, 500);
  }
}

async function handle({ request, env }) {
  const body = await request.json();
  const { batchId, name, prompt } = body || {};

  if (!batchId || !name || !prompt) {
    return json({ error: 'missing fields (batchId, name, prompt required)' }, 400);
  }
  if (!env.DECLUTTER_QUEUE) {
    return json({ error: 'Queue binding DECLUTTER_QUEUE is missing on this Pages project' }, 500);
  }

  const raw = await env.BATCHES.get(`batch:${batchId}`);
  if (!raw) return json({ error: 'batch not found' }, 404);
  const manifest = JSON.parse(raw);
  const item = manifest.items.find((i) => i.name === name);
  if (!item) return json({ error: 'item not found in batch' }, 404);
  if (!item.resultKey || !item.filename) {
    return json({ error: 'no existing result to touch up' }, 400);
  }

  const origin = new URL(request.url).origin;

  // Write the touched-up result to a new key so the previous result stays
  // intact in R2 if Gemini blows up mid-touch-up.
  const stamp = Date.now().toString(36);
  const base = item.filename.replace(/\.png$/i, '');
  const newFilename = `${base}_t${stamp}.png`;
  const newResultKey = `batches/${batchId}/${newFilename}`;

  item.status = 'proc';
  item.error = null;
  item.touchUpAt = new Date().toISOString();
  await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));

  await env.DECLUTTER_QUEUE.send({
    batchId,
    name,
    prompt: String(prompt).slice(0, 32000),
    originalKey: item.originalKey,
    originalFilename: item.originalFilename,
    filename: newFilename,
    sourceKey: item.resultKey,
    resultKey: newResultKey,
    origin,
  });

  return json({
    ok: true,
    queued: true,
    url: `/img/${batchId}/${newFilename}`,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
