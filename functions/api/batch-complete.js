export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const batchId = body.batchId;
  if (!batchId) return json({ error: 'batchId required' }, 400);

  const raw = await env.BATCHES.get(`batch:${batchId}`);
  if (!raw) return json({ error: 'batch not found' }, 404);
  const manifest = JSON.parse(raw);

  if (manifest.notified) return json({ ok: true, alreadyNotified: true });

  const done = manifest.items.filter((i) => i.status === 'done');
  const errs = manifest.items.filter((i) => i.status === 'err');
  const total = manifest.items.length;

  const origin = new URL(request.url).origin;
  const galleryUrl = `${origin}/batch/${batchId}`;

  const lines = [
    `*Batch ready* — ${done.length} of ${total} processed`,
  ];
  if (errs.length) lines.push(`${errs.length} failed`);
  lines.push('', `[Open gallery](${galleryUrl})`);
  const text = lines.join('\n');

  const tgRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    }
  );

  if (!tgRes.ok) {
    const detail = await tgRes.text();
    return json({ error: 'Telegram send failed', status: tgRes.status, detail }, 502);
  }

  manifest.notified = true;
  await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));

  return json({ ok: true, galleryUrl, done: done.length, total });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
