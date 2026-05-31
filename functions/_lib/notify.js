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
  if (manifest.label) lines.push(escapeMd(manifest.label));
  if (errs.length) lines.push(`${errs.length} failed`);
  lines.push('', `[Open gallery](${galleryUrl})`);

  // TELEGRAM_CHAT_ID may hold one chat ID or a comma-separated list. Send
  // to each, treat the batch as "notified" if at least one succeeds. Only
  // roll back `notified` if every chat fails (so we retry next time).
  const chatIds = String(env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const results = [];
  for (const chatId of chatIds) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: lines.join('\n'),
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        }
      );
      if (res.ok) results.push({ chatId, ok: true });
      else results.push({ chatId, ok: false, status: res.status, detail: await res.text() });
    } catch (e) {
      results.push({ chatId, ok: false, error: e.message });
    }
  }
  const anyOk = results.some((r) => r.ok);
  if (!anyOk) {
    manifest.notified = false;
    await env.BATCHES.put(`batch:${batchId}`, JSON.stringify(manifest));
    return { error: 'All Telegram chats failed', results };
  }
  return { ok: true, done: done.length, total, galleryUrl, results };
}

// Telegram parse_mode: 'Markdown' (v1) only treats _ * [ ` as special.
function escapeMd(s) {
  return String(s).replace(/([_*\[\]`])/g, '\\$1');
}
