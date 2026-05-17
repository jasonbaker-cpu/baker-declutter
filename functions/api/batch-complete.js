import { sendTelegramIfComplete } from '../_lib/notify.js';

// Kept as a fallback: the browser also calls this when it knows the batch
// is done. The shared helper's `notified` flag prevents double-send if the
// server-side trigger in /api/edit-image already fired.
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const batchId = body.batchId;
  if (!batchId) return json({ error: 'batchId required' }, 400);

  const origin = new URL(request.url).origin;
  const result = await sendTelegramIfComplete(env, batchId, origin);
  return json(result);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
