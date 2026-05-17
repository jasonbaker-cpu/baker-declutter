export async function onRequestGet({ env }) {
  const list = await env.BATCHES.list({ prefix: 'batch:', limit: 100 });

  const batches = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.BATCHES.get(k.name);
      if (!raw) return null;
      let m;
      try { m = JSON.parse(raw); } catch { return null; }
      const doneItems = m.items.filter((i) => i.status === 'done' && i.filename);
      return {
        id: m.id,
        createdAt: m.createdAt,
        total: m.items.length,
        done: doneItems.length,
        thumbnail: doneItems[0] ? `/img/${m.id}/${doneItems[0].filename}` : null,
      };
    })
  );

  const valid = batches
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return new Response(JSON.stringify({ batches: valid }), {
    headers: { 'content-type': 'application/json' },
  });
}
