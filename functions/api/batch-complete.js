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

  const firstThumb = done[0]
    ? `${origin}/img/${batchId}/${done[0].filename}`
    : null;

  const embed = {
    title: `Batch ready — ${done.length} of ${total} processed`,
    url: galleryUrl,
    color: 0xc94a0c,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'Completed', value: String(done.length), inline: true },
      { name: 'Failed', value: String(errs.length), inline: true },
    ],
  };
  if (errs.length === 0) embed.fields.pop();
  if (firstThumb) embed.image = { url: firstThumb };

  const payload = {
    content: `New batch ready: <${galleryUrl}>`,
    embeds: [embed],
  };

  const discordRes = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!discordRes.ok) {
    const detail = await discordRes.text();
    return json({ error: 'Discord webhook failed', status: discordRes.status, detail }, 502);
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
