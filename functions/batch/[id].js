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

  const images = done.map((item) => ({
    url: `/img/${id}/${item.filename}`,
    name: item.name,
    filename: item.filename,
  }));

  const cards = images
    .map((img, i) => `
      <div class="card">
        <div class="card-img" onclick="openLb(${i})">
          <img src="${escapeAttr(img.url)}" loading="lazy" alt="${escapeAttr(img.name)}">
          <div class="card-overlay">Click to view</div>
        </div>
        <div class="card-body">
          <div class="card-name">${escapeHtml(img.name)}</div>
          <a class="dl-btn" href="${escapeAttr(img.url)}" download="${escapeAttr(img.filename)}" onclick="event.stopPropagation()">Download</a>
        </div>
      </div>
    `)
    .join('\n');

  const errSection = errs.length
    ? `<div class="errs"><div class="err-title">Failed (${errs.length})</div>${errs
        .map((e) => `<div class="err-item">${escapeHtml(e.name)} &mdash; ${escapeHtml(e.error || 'unknown error')}</div>`)
        .join('')}</div>`
    : '';

  const waitingSection = waiting.length
    ? `<div class="waiting">${waiting.length} still processing. <a href="">Refresh</a> to check.</div>`
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
.card-img{position:relative;cursor:zoom-in;background:#000;}
.card-img img{width:100%;height:220px;object-fit:cover;display:block;}
.card-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-family:"DM Mono",monospace;letter-spacing:.06em;text-transform:uppercase;opacity:0;transition:opacity .2s;}
.card-img:hover .card-overlay{opacity:1;}
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

/* Lightbox */
.lb{position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:1000;display:none;align-items:center;justify-content:center;}
.lb.open{display:flex;}
.lb-img{max-width:95vw;max-height:88vh;object-fit:contain;user-select:none;-webkit-user-drag:none;}
.lb-btn{position:absolute;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:50%;width:48px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;font-family:"DM Mono",monospace;transition:all .15s;backdrop-filter:blur(4px);}
.lb-btn:hover{background:#c94a0c;border-color:#c94a0c;}
.lb-close{top:20px;right:20px;}
.lb-prev{left:20px;top:50%;transform:translateY(-50%);}
.lb-next{right:20px;top:50%;transform:translateY(-50%);}
.lb-info{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);padding:8px 16px;border-radius:6px;font-size:11px;font-family:"DM Mono",monospace;color:rgba(255,255,255,0.8);backdrop-filter:blur(4px);display:flex;align-items:center;gap:12px;max-width:90vw;}
.lb-counter{color:#c94a0c;font-weight:600;}
.lb-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;}
.lb-dl{color:#fff;text-decoration:underline;cursor:pointer;background:none;border:none;font-family:inherit;font-size:inherit;padding:0;}
@media (max-width:600px){
  .lb-btn{width:40px;height:40px;font-size:16px;}
  .lb-prev{left:8px;}
  .lb-next{right:8px;}
  .lb-close{top:12px;right:12px;}
  .lb-name{max-width:140px;}
}
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

<div class="lb" id="lb" onclick="if(event.target.id==='lb')lbClose()">
  <button class="lb-btn lb-close" onclick="lbClose()" aria-label="Close">&times;</button>
  <button class="lb-btn lb-prev" onclick="lbPrev()" aria-label="Previous">&#8249;</button>
  <button class="lb-btn lb-next" onclick="lbNext()" aria-label="Next">&#8250;</button>
  <img class="lb-img" id="lb-img" alt="">
  <div class="lb-info">
    <span class="lb-counter" id="lb-counter">1 / 1</span>
    <span class="lb-name" id="lb-name"></span>
    <button class="lb-dl" id="lb-dl" onclick="lbDownload()">Download</button>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script>
var IMGS = ${JSON.stringify(images)};
var BATCH_ID = ${JSON.stringify(id)};
var lbIdx = 0;

function openLb(i) {
  lbIdx = i;
  updateLb();
  document.getElementById('lb').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function lbClose() {
  document.getElementById('lb').classList.remove('open');
  document.body.style.overflow = '';
}
function lbPrev() {
  lbIdx = (lbIdx - 1 + IMGS.length) % IMGS.length;
  updateLb();
}
function lbNext() {
  lbIdx = (lbIdx + 1) % IMGS.length;
  updateLb();
}
function updateLb() {
  var img = IMGS[lbIdx];
  document.getElementById('lb-img').src = img.url;
  document.getElementById('lb-img').alt = img.name;
  document.getElementById('lb-counter').textContent = (lbIdx + 1) + ' / ' + IMGS.length;
  document.getElementById('lb-name').textContent = img.name;
  // Preload neighbours
  if (IMGS.length > 1) {
    new Image().src = IMGS[(lbIdx + 1) % IMGS.length].url;
    new Image().src = IMGS[(lbIdx - 1 + IMGS.length) % IMGS.length].url;
  }
}
function lbDownload() {
  var img = IMGS[lbIdx];
  var a = document.createElement('a');
  a.href = img.url;
  a.download = img.filename;
  a.click();
}

document.addEventListener('keydown', function(e) {
  if (!document.getElementById('lb').classList.contains('open')) return;
  if (e.key === 'Escape') lbClose();
  else if (e.key === 'ArrowLeft') lbPrev();
  else if (e.key === 'ArrowRight') lbNext();
});

// Swipe support for mobile
var touchStartX = 0;
document.getElementById('lb').addEventListener('touchstart', function(e) {
  touchStartX = e.changedTouches[0].screenX;
});
document.getElementById('lb').addEventListener('touchend', function(e) {
  var diff = e.changedTouches[0].screenX - touchStartX;
  if (Math.abs(diff) > 50) {
    if (diff < 0) lbNext(); else lbPrev();
  }
});

${done.length ? `
function downloadAll() {
  var zip = new JSZip();
  var btn = document.getElementById('dl-all');
  btn.textContent = 'Zipping...'; btn.disabled = true;
  Promise.all(IMGS.map(function(img) {
    return fetch(img.url).then(function(r) { return r.blob(); }).then(function(b) {
      zip.file(img.filename, b);
    });
  })).then(function() {
    return zip.generateAsync({ type: 'blob' });
  }).then(function(blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = BATCH_ID + '.zip';
    a.click();
    btn.textContent = 'Download all (.zip)'; btn.disabled = false;
  });
}
` : ''}
</script>
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
