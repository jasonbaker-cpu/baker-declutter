export async function onRequestGet({ params, env, request }) {
  const { id } = params;

  const raw = await env.BATCHES.get(`batch:${id}`);
  if (!raw) {
    return html(notFoundPage(id), 404);
  }

  const manifest = JSON.parse(raw);
  const done = manifest.items.filter((i) => i.status === 'done');
  const errs = manifest.items.filter((i) => i.status === 'err');
  const waiting = manifest.items.filter((i) => i.status === 'wait' || i.status === 'proc');
  const created = new Date(manifest.createdAt).toLocaleString('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const cards = done
    .map((item) => {
      const imgUrl = `/img/${id}/${escapeAttr(item.filename)}`;
      return `
        <div class="card">
          <a href="${imgUrl}" target="_blank"><img src="${imgUrl}" loading="lazy" alt="${escapeAttr(item.name)}"></a>
          <div class="card-body">
            <div class="card-name">${escapeHtml(item.name)}</div>
            <a class="dl-btn" href="${imgUrl}" download="${escapeAttr(item.filename)}">Download</a>
          </div>
        </div>
      `;
    })
    .join('\n');

  const errSection = errs.length
    ? `<div class="errs"><div class="err-title">Failed (${errs.length})</div>${errs
        .map((e) => `<div class="err-item">${escapeHtml(e.name)} &mdash; ${escapeHtml(e.error || 'unknown error')}</div>`)
        .join('')}</div>`
    : '';

  const waitingSection = waiting.length
    ? `<div class="waiting">${waiting.length} still processing. <a href="">Refresh</a> to check.</div>`
    : '';

  const downloadAllScript = done.length
    ? `
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
      <script>
        var BATCH_ID = ${JSON.stringify(id)};
        var DONE = ${JSON.stringify(done.map((d) => d.filename))};
        function downloadAll() {
          var zip = new JSZip();
          var btn = document.getElementById('dl-all');
          btn.textContent = 'Zipping...'; btn.disabled = true;
          Promise.all(DONE.map(function(f) {
            return fetch('/img/' + BATCH_ID + '/' + f).then(function(r) { return r.blob(); }).then(function(b) {
              zip.file(f, b);
            });
          })).then(function() {
            return zip.generateAsync({ type: 'blob' });
          }).then(function(blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = BATCH_ID + '.zip';
            a.click();
            btn.textContent = 'Download all'; btn.disabled = false;
          });
        }
      </script>
    `
    : '';

  const body = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(id)} &mdash; Baker Declutter</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:"Syne",sans-serif;background:#080808;color:#fff;min-height:100vh;}
.header{padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.07);background:#111;}
.logo{font-size:17px;font-weight:700;letter-spacing:-.03em;text-decoration:none;color:#fff;}
.logo em{color:#c94a0c;font-style:normal;}
.tag{font-size:10px;font-family:"DM Mono",monospace;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em;}
.wrap{padding:32px 24px;max-width:1400px;margin:0 auto;}
.batch-meta{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;}
.batch-title{font-size:22px;font-weight:700;}
.batch-sub{font-size:12px;font-family:"DM Mono",monospace;color:rgba(255,255,255,0.4);margin-top:4px;}
.dl-all-btn{font-size:12px;font-family:"DM Mono",monospace;background:#c94a0c;color:#fff;border:none;border-radius:6px;padding:10px 18px;cursor:pointer;}
.dl-all-btn:disabled{opacity:.5;cursor:wait;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;}
.card{background:#111;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;}
.card img{width:100%;height:220px;object-fit:cover;display:block;background:#000;}
.card-body{padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;}
.card-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
.dl-btn{font-size:10px;font-family:"DM Mono",monospace;background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:6px 12px;cursor:pointer;text-decoration:none;}
.dl-btn:hover{background:#c94a0c;border-color:#c94a0c;}
.empty{padding:60px 20px;text-align:center;color:rgba(255,255,255,0.4);}
.errs{margin-top:32px;padding:16px;background:rgba(201,64,64,0.06);border:1px solid rgba(201,64,64,0.2);border-radius:8px;}
.err-title{font-size:11px;font-family:"DM Mono",monospace;color:#e07070;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;}
.err-item{font-size:12px;color:rgba(255,255,255,0.6);font-family:"DM Mono",monospace;margin:4px 0;}
.waiting{margin-bottom:16px;padding:10px 14px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:12px;color:rgba(255,255,255,0.6);}
.waiting a{color:#c94a0c;}
</style>
</head>
<body>
<div class="header">
  <a href="/" class="logo">Baker<em>.</em></a>
  <div class="tag">Batch gallery</div>
</div>
<div class="wrap">
  <div class="batch-meta">
    <div>
      <div class="batch-title">${escapeHtml(id)}</div>
      <div class="batch-sub">${escapeHtml(created)} &middot; ${done.length} of ${manifest.items.length} done${errs.length ? ` &middot; ${errs.length} failed` : ''}</div>
    </div>
    ${done.length ? `<button class="dl-all-btn" id="dl-all" onclick="downloadAll()">Download all (.zip)</button>` : ''}
  </div>
  ${waitingSection}
  ${done.length ? `<div class="grid">${cards}</div>` : '<div class="empty">No completed images in this batch yet.</div>'}
  ${errSection}
</div>
${downloadAllScript}
</body>
</html>`;

  return html(body);
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function notFoundPage(id) {
  return `<!DOCTYPE html><html><head><title>Not found</title><style>body{font-family:sans-serif;background:#080808;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><div><h1>Batch not found</h1><p>No batch with id <code>${escapeHtml(id)}</code>.</p><p><a href="/" style="color:#c94a0c">Back to app</a></p></div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
