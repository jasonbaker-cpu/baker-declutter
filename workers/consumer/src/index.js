// Queue consumer Worker for baker-declutter.
//
// Pulls one job per invocation off the `declutter-jobs` queue, runs the
// Gemini image-edit, stores the result to R2, updates the batch manifest
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
        // Back off harder for transient overload-style errors so we don't
        // hammer Gemini while it's already saying "high demand".
        const msg = String(e.message || '').toLowerCase();
        const isOverload =
          msg.includes('high demand') ||
          msg.includes('overloaded') ||
          msg.includes('try again later') ||
          msg.includes('retryable gemini error');
        if (isOverload) message.retry({ delay: 90 });
        else message.retry();
      }
    }
  },

};

async function processJob(job, env) {
  const { batchId, name, prompt, originalKey, originalFilename, filename, resultKey, sourceKey, origin } = job;

  // Mark the item back to 'proc' if we're being retried after a previous
  // attempt wrote 'err' — keeps the UI in sync with the current attempt.
  await updateItem(env, batchId, name, {
    status: 'proc',
    error: null,
    consumerStartedAt: new Date().toISOString(),
  });

  // For touch-up jobs sourceKey points at the previous result; for the
  // first pass it's absent and we read the upload at originalKey.
  const inputKey = sourceKey || originalKey;
  const inputObj = await env.R2_BUCKET.get(inputKey);
  if (!inputObj) throw new Error('Input not found in R2: ' + inputKey);
  const imageBytes = await inputObj.arrayBuffer();

  // Try Gemini first. If it returns a transient/overload error or any
  // HTTP-level failure, fall through to OpenAI for this image so the
  // batch can keep moving while Google is having a bad day. Terminal
  // Gemini errors (content policy, invalid arg) skip the fallback —
  // OpenAI would refuse for the same reason and we'd just waste money.
  let resultBytes = null;
  let usedProvider = 'gemini';
  let geminiTerminal = null;

  try {
    resultBytes = await callGemini(imageBytes, prompt, env);
  } catch (e) {
    if (e && e.terminal) {
      geminiTerminal = e;
    }
    // else: retryable / transport-level → fall through to OpenAI
  }

  if (!resultBytes && geminiTerminal) {
    await updateItem(env, batchId, name, {
      status: 'err',
      error: geminiTerminal.message,
    });
    await sendTelegramIfComplete(env, batchId, origin);
    return;
  }

  if (!resultBytes) {
    if (!env.OPENAI_KEY) {
      // No fallback configured; surface the Gemini failure so the queue
      // can retry per its normal policy.
      throw new Error('Gemini failed and no OPENAI_KEY fallback is configured');
    }
    usedProvider = 'openai';
    resultBytes = await callOpenAI(imageBytes, prompt, env); // throws on failure
  }

  await env.R2_BUCKET.put(resultKey, resultBytes, {
    httpMetadata: { contentType: 'image/png' },
  });

  await updateItem(env, batchId, name, {
    status: 'done',
    originalKey,
    originalFilename,
    resultKey,
    filename,
    provider: usedProvider,
    error: null,
  });

  await sendTelegramIfComplete(env, batchId, origin);
}

// Calls Gemini's gemini-3-pro-image-preview. Returns Uint8Array of the
// PNG bytes. Throws on any failure; if the failure is terminal (content
// policy block, bad arg, etc.) the thrown error has `.terminal = true`
// so processJob can skip the OpenAI fallback.
async function callGemini(imageBytes, prompt, env) {
  if (!env.GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY not set');
    throw e;
  }
  const imageBase64 = bytesToBase64(new Uint8Array(imageBytes));
  const body = {
    contents: [
      {
        parts: [
          { text: String(prompt).slice(0, 32000) },
          { inline_data: { mime_type: 'image/png', data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      imageConfig: { imageSize: '4K' },
      temperature: 0,
    },
  };
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid Gemini response (HTTP ' + res.status + '): ' + text.slice(0, 300));
  }
  if (data.error) {
    if (isRetryableGeminiError(data.error)) {
      throw new Error('Retryable Gemini error: ' + (data.error.message || JSON.stringify(data.error)));
    }
    const err = new Error(data.error.message || 'Gemini terminal error');
    err.terminal = true;
    throw err;
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p?.inlineData?.data);
  const b64 = imagePart?.inlineData?.data;
  if (!b64) throw new Error('No image in Gemini response');
  return base64ToBytes(b64);
}

// OpenAI fallback. Uses the same prompt and image bytes; expects the
// OPENAI_KEY secret to still be set on this Worker. Throws on failure.
async function callOpenAI(imageBytes, prompt, env) {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', new Blob([imageBytes], { type: 'image/png' }), 'image.png');
  form.append('prompt', String(prompt).slice(0, 32000));
  form.append('n', '1');
  form.append('size', '1920x1280');
  form.append('quality', 'high');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
    body: form,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid OpenAI response (HTTP ' + res.status + '): ' + text.slice(0, 300));
  }
  if (data.error) {
    throw new Error('OpenAI error: ' + (data.error.message || JSON.stringify(data.error)));
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image in OpenAI response');
  return base64ToBytes(b64);
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

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Classify a structured Gemini error object as retryable (transient
// server-side issue) vs terminal (caller's fault: bad prompt, content
// policy block, invalid arg). Retryable errors get re-queued with
// backoff; terminal errors mark the item 'err' and stop.
function isRetryableGeminiError(err) {
  if (!err) return false;
  const code = err.code;
  const status = String(err.status || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  if (typeof code === 'number' && (code === 429 || (code >= 500 && code < 600))) return true;
  if (
    status === 'UNAVAILABLE' ||
    status === 'RESOURCE_EXHAUSTED' ||
    status === 'INTERNAL' ||
    status === 'DEADLINE_EXCEEDED' ||
    status === 'ABORTED'
  ) return true;
  if (
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('try again later') ||
    msg.includes('temporarily unavailable')
  ) return true;
  return false;
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
  if (manifest.label) lines.push(escapeMd(manifest.label));
  if (errs.length) lines.push(`${errs.length} failed`);
  lines.push('', `[Open gallery](${galleryUrl})`);
  // TELEGRAM_CHAT_ID may hold one chat ID or a comma-separated list — send
  // to each. Per-chat failures are swallowed so one offline chat can't
  // block the others.
  const chatIds = String(env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: lines.join('\n'),
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
    } catch {}
  }
}

function escapeMd(s) {
  return String(s).replace(/([_*\[\]`])/g, '\\$1');
}
