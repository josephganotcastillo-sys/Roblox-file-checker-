'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let filter = 'all';
let search = '';
let lastRender = 0;
let lastKey = '';
let snap = null;

/* ---------- input ---------- */
const ta = $('#combos');

function updateCount() {
  const n = ta.value.split('\n').filter((l) => l.trim() && l.includes(':')).length;
  $('#count').textContent = n + ' combo' + (n === 1 ? '' : 's');
}
ta.addEventListener('input', updateCount);
updateCount();

$('#loadFile').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  ta.value = await f.text();
  updateCount();
  e.target.value = '';
});
$('#pasteBtn').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { ta.value = (ta.value ? ta.value + '\n' : '') + t; updateCount(); }
  } catch {}
});

/* ---------- controls ---------- */
$('#startBtn').addEventListener('click', async () => {
  const combos = ta.value.split('\n');
  if (!combos.filter((l) => l.trim()).length) { alert('Paste some combos first.'); return; }

  const settings = {
    concurrency: Math.max(1, Math.min(30, +$('#concurrency').value || 5)),
    delay: Math.max(0, +$('#delay').value || 0),
    retries: Math.max(0, Math.min(5, +$('#retries').value || 0)),
    enrich: $('#enrich').checked,
    robux: $('#robux').checked && (+$('#concurrency').value === 1)
  };

  const res = await send({ type: 'start', combos, settings });
  if (res && res.ok === false) alert(res.error || 'Could not start.');
});

$('#pauseBtn').addEventListener('click', async () => {
  if (snap && snap.paused) { await send({ type: 'resume' }); }
  else { await send({ type: 'pause' }); }
});

$('#stopBtn').addEventListener('click', async () => { await send({ type: 'stop' }); });
$('#clearBtn').addEventListener('click', async () => { await send({ type: 'clear' }); });

$$('.chip').forEach((c) => c.addEventListener('click', () => {
  filter = c.dataset.f;
  $$('.chip').forEach((x) => x.classList.toggle('on', x === c));
  lastKey = '';
  render(true);
}));

$('#search').addEventListener('input', (e) => { search = e.target.value.toLowerCase(); lastKey = ''; render(true); });

function send(msg) {
  return new Promise((r) => {
    try { chrome.runtime.sendMessage(msg, (resp) => r(resp)); } catch { r(null); }
  });
}

/* ---------- rendering ---------- */
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function setPill(mode) {
  const p = $('#pill');
  p.className = 'pill ' + (mode === 'run' ? 'run' : mode === 'pause' ? 'pause' : 'idle');
  p.textContent = mode === 'run' ? 'running' : mode === 'pause' ? 'paused' : mode === 'done' ? 'done' : 'idle';
}

function applySnap(s) {
  snap = s;
  if (!s || !s.job) {
    $('#progressCard').classList.add('hidden');
    $('#resultsWrap').classList.add('hidden');
    $('#summaryCard').classList.add('hidden');
    setPill('idle');
    return;
  }

  const st = s.job.stats;
  const done = st.checked;
  const total = st.total;

  $('#progressCard').classList.remove('hidden');
  $('#resultsWrap').classList.remove('hidden');
  $('#setup').classList.toggle('hidden', s.running || s.paused || done > 0);

  $('#cDone').textContent = done + '/' + total;
  $('#cValid').textContent = st.valid;
  $('#cInvalid').textContent = st.invalid;
  $('#cTwofa').textContent = st.twofa;
  $('#cCaptcha').textContent = st.captcha;
  $('#cError').textContent = st.error;
  $('#bar').style.width = total ? (done / total) * 100 + '%' : '0%';

  $('#pauseBtn').classList.toggle('hidden', s.job.done);
  $('#stopBtn').classList.toggle('hidden', s.job.done);
  $('#pauseBtn').textContent = s.paused ? 'Resume' : 'Pause';

  if (s.job.done) {
    setPill('done');
    showSummary(s);
  } else {
    setPill(s.paused ? 'pause' : 'run');
    $('#summaryCard').classList.add('hidden');
  }

  render();
}

function showSummary(s) {
  const st = s.job.stats;
  const rate = st.total ? ((st.valid / st.total) * 100).toFixed(1) : '0.0';
  const dur = (s.job.endedAt || Date.now()) - s.job.startedAt;
  $('#summaryBody').innerHTML = `
    <div class="sumgrid">
      <div><b>${st.total}</b><span>checked</span></div>
      <div><b style="color:var(--ok)">${st.valid}</b><span>valid</span></div>
      <div><b style="color:var(--bad)">${st.invalid}</b><span>invalid</span></div>
      <div><b style="color:var(--warn)">${st.twofa}</b><span>2FA / verify</span></div>
      <div><b>${st.captcha}</b><span>captcha wall</span></div>
      <div><b>${rate}%</b><span>hit rate</span></div>
    </div>
    <p class="muted">Finished in ${fmtTime(dur)} · ${st.error} errors</p>`;
  $('#summaryCard').classList.remove('hidden');
}

function render(force) {
  if (!snap || !snap.job) return;
  const now = Date.now();
  const st = snap.job.stats;
  const key = [filter, search, st.checked, snap.job.done].join('|');
  if (!force && key === lastKey && now - lastRender < 700) return;
  lastKey = key;
  lastRender = now;

  let rows = snap.job.items;
  if (filter !== 'all') rows = rows.filter((i) => i.status === filter);
  if (search) {
    rows = rows.filter((i) =>
      i.user.toLowerCase().includes(search) ||
      (i.name || '').toLowerCase().includes(search) ||
      (i.display || '').toLowerCase().includes(search));
  }

  const cap = 400;
  const slice = rows.slice(0, cap);

  $('#list').innerHTML = slice.map((i) => {
    const avatar = i.avatar ? `<img src="${i.avatar}" alt="">` : '<img alt="">';
    const extra = [i.display && i.display !== i.user ? '@' + i.display : '', i.created ? 'joined ' + i.created : '', i.robux !== undefined ? i.robux + ' R$' : '', i.note].filter(Boolean).join(' · ');
    return `<div class="item ${i.status}">
      ${avatar}
      <div class="meta">
        <div class="u">${esc(i.name || i.user)}</div>
        <div class="p">${esc(i.user)}:${esc(i.pass)}</div>
        ${extra ? `<div class="ex">${esc(extra)}</div>` : ''}
      </div>
      <span class="badge ${i.status}">${i.status}</span>
    </div>`;
  }).join('');

  $('#moreNote').textContent = rows.length > cap
    ? `Showing first ${cap} of ${rows.length} matching — use search to narrow.`
    : rows.length ? '' : 'No matches.';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- exports ---------- */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

$('#expValid').addEventListener('click', () => {
  if (!snap || !snap.job) return;
  const v = snap.job.items.filter((i) => i.status === 'valid');
  if (!v.length) return alert('No valid accounts yet.');
  download(`valid-${stamp()}.txt`, v.map((i) => `${i.user}:${i.pass}`).join('\n'));
});

$('#expAll').addEventListener('click', () => {
  if (!snap || !snap.job) return;
  const head = 'status,username,password,display_name,user_id,created,robux,note';
  const body = snap.job.items.map((i) =>
    [i.status, i.user, i.pass, i.display || '', i.userId || '', i.created || '', i.robux ?? '', i.note || '']
      .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
  download(`results-${stamp()}.csv`, [head, ...body].join('\n'));
});

$('#expCookies').addEventListener('click', () => {
  if (!snap || !snap.job) return;
  const v = snap.job.items.filter((i) => i.status === 'valid');
  if (!v.length) return alert('No valid accounts yet.');
  download(`valid-cookies-${stamp()}.txt`,
    v.map((i) => `${i.user}:${i.pass}:${i.userId || ''}`).join('\n'));
});

/* ---------- poll ---------- */
async function tick() {
  const s = await send({ type: 'get' });
  if (s) applySnap(s);
}
tick();
setInterval(tick, 500);
