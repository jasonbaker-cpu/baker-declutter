export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: 'items required' }, 400);
  }

  const id = 'batch-' + crypto.randomUUID().slice(0, 8);
  const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
  const manifest = {
    id,
    label: rawLabel ? rawLabel.slice(0, 200) : null,
    createdAt: new Date().toISOString(),
    items: items.map((it) => ({ name: String(it.name), status: 'wait' })),
    notified: false,
  };

  await env.BATCHES.put(`batch:${id}`, JSON.stringify(manifest));
  return json({ id, manifest });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const raw = await env.BATCHES.get(`batch:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);

  return new Response(raw, { headers: { 'content-type': 'application/json' } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
