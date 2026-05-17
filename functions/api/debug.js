// One-shot diagnostic endpoint. Visit /api/debug in your browser; it reports
// which env vars + bindings are wired up and tries to send a test message to
// Telegram. Returns the raw Telegram response so you can see exactly why it
// failed. Safe to keep deployed — it's behind Cloudflare Access and never
// echoes secret values, only presence/length.
export async function onRequestGet({ env }) {
  const report = {
    bindings: {
      R2_BUCKET: !!env.R2_BUCKET ? 'bound' : 'MISSING',
      BATCHES_KV: !!env.BATCHES ? 'bound' : 'MISSING',
    },
    env: {
      OPENAI_KEY: presence(env.OPENAI_KEY),
      TELEGRAM_BOT_TOKEN: presence(env.TELEGRAM_BOT_TOKEN),
      TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID
        ? `set (value: ${env.TELEGRAM_CHAT_ID})`
        : 'MISSING',
    },
    telegram_test: null,
  };

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: 'Test from /api/debug — if you see this, Telegram is wired up correctly.',
          }),
        }
      );
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      report.telegram_test = { status: res.status, ok: res.ok, response: parsed };
    } catch (e) {
      report.telegram_test = { error: e.message };
    }
  } else {
    report.telegram_test = 'skipped (token or chat_id missing)';
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

function presence(v) {
  if (!v) return 'MISSING';
  return `set (length: ${String(v).length})`;
}
