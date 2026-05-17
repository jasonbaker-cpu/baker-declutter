export async function onRequestGet({ params, env }) {
  const { batchId, name } = params;
  const key = `batches/${batchId}/${name}`;

  const object = await env.R2_BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=86400');
  return new Response(object.body, { headers });
}
