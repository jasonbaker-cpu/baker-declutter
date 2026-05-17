// Checks whether a batch is fully terminal (all items done or err) and fires
// the Telegram notification exactly once. Safe to call from any function on
// every item-completion event — the `notified` flag prevents duplicates.
export async function sendTelegramIfComplete(env, batchId, origin) {
  const raw = await env.BATCHES.get(`batch:${batchId}`);
  if (!raw) return { skipped: 'no manifest' };
  const manifest = JSON.parse(raw);

  if (manifest.notified) return { skipped: 'already notified' };

  const pending = manifest.items.filter(
    (i) => i.status !== 'done' && i.status !== 'err'
  );
  if (pending.length > 0) return { skipped: `${pending.length} still pending` };

  manifest.notified = true;
  await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));

  const done = manifest.items.filter((i) => i.status === 'done');
  const errs = manifest.items.filter((i) => i.status === 'err');
  const total = manifest.items.length;
  const galleryUrl = `${origin}/batch/${batchId}`;

  const lines = [`*Batch ready* — ${done.length} of ${total} processed`];
  if (errs.length) lines.push(`${errs.length} failed`);
  lines.push('', `[Open gallery](${galleryUrl})`);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: lines.join('\n'),
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      manifest.notified = false;
      await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));
      const detail = await res.text();
      return { error: 'Telegram failed', status: res.status, detail };
    }
    return { ok: true, done: done.length, total, galleryUrl };
  } catch (e) {
    manifest.notified = false;
    await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));
    return { error: 'Telegram exception', message: e.message };
  }
}
