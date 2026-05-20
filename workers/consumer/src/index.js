// Queue consumer Worker for baker-declutter.
//
// Pulls one job per invocation off the `declutter-jobs` queue, runs the
// OpenAI image-edit, stores the result to R2, updates the batch manifest
// in KV. On any throw the message is retried by Cloudflare automatically
// (up to whatever max_retries is set in wrangler.toml). After retries are
// exhausted the message goes to the configured DLQ — or is dropped if no
// DLQ is wired up.
//
// Lives outside the Pages project because Pages Functions don't have the
// runtime characteristics needed for multi-minute background work.

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        await processJob(job, env);
        message.ack();
      } catch (e) {
        // Write the failure into the manifest so the client polling sees
        // it even before all retries are exhausted. The 'err' here is
        // tentative — next retry may flip it back to 'proc'/'done'.
        try {
          await updateItem(env, job.batchId, job.name, {
            status: 'err',
            error: 'Consumer attempt ' + (message.attempts || 1) + ': ' + (e.message || String(e)),
          });
        } catch {}
        message.retry();
      }
    }
  },
};

async function processJob(job, env) {
  const { batchId, name, prompt, originalKey, originalFilename, filename, resultKey, origin } = job;

  // Mark the item back to 'proc' if we're being retried after a previous
  // attempt wrote 'err' — keeps the UI in sync with the current attempt.
  await updateItem(env, batchId, name, {
    status: 'proc',
    error: null,
    consumerStartedAt: new Date().toISOString(),
  });

  const originalObj = await env.R2_BUCKET.get(originalKey);
  if (!originalObj) throw new Error('Original not found in R2: ' + originalKey);
  const imageBytes = await originalObj.arrayBuffer();

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
    throw new Error('Invalid OpenAI response (HTTP ' + openaiRes.status + '): ' + text.slice(0, 300));
  }

  if (data.error) {
    // OpenAI returned a structured error (bad request, content policy,
    // etc.). These will not succeed on retry, so mark terminal err and
    // ack (do not retry) by returning normally.
    await updateItem(env, batchId, name, {
      status: 'err',
      error: data.error.message,
    });
    await sendTelegramIfComplete(env, batchId, origin);
    return;
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image in OpenAI response');

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

async function sendTelegramIfComplete(env, batchId, origin) {
  const raw = await env.BATCHES.get(`batch:${batchId}`);
  if (!raw) return;
  const manifest = JSON.parse(raw);
  if (manifest.notified) return;
  const pending = manifest.items.filter((i) => i.status !== 'done' && i.status !== 'err');
  if (pending.length > 0) return;
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
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: lines.join('\n'),
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}
