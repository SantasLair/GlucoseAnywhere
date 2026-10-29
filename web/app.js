import { DexcomClient, DexcomError } from './dexcom.js';
import { drawChart } from './chart.js';
import {
  loadPrefs, savePrefs, loadCreds, saveCreds, clearCreds,
  putReadings, getReadings, pruneReadings, forgetEverything, describeStorage,
} from './store.js';
import {
  MMOL, TREND_ARROWS, STALE_MS, unitsLabel, fmtGlucose, fmtGlucoseNum, parseNum,
  fmtDelta, glucoseClass, fmtAge, fmtClock, esc,
} from './format.js';

const VERSION = '1.0.0';
const DAY_MS = 24 * 3600e3;
const POLL_MS = 60e3;          // check once a minute; Dexcom produces a reading every 5
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- state
let prefs = loadPrefs();
if (![3, 6, 12, 24].includes(prefs.range)) prefs.range = 6;
let creds = null;            // { username, password, region, remember, accountId?, sessionId? }
let client = null;
let readings = [];           // last 24 h, oldest first
let status = { state: 'none', message: '' };   // none | ok | auth | error
let tab = 'home';
let fetching = false;
let lastFetch = 0;
let pollTimer = null, ageTimer = null;

const setMsg = (id, text = '') => { $(id).textContent = text; };
const nowMs = () => Date.now();

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------- auth
function showAuth(message = '') {
  stopPolling();
  if (!$('big').hidden) exitBig();
  $('app').hidden = true;
  $('auth').hidden = false;
  setMsg('authError', message);
}

$('authAbout').addEventListener('click', e => {
  e.preventDefault();
  $('auth').hidden = true;
  $('app').hidden = false;
  showTab('settings');
  $('about').scrollIntoView();
  $('tabbar').hidden = true;      // not signed in: nothing else to navigate to
  const back = document.createElement('button');
  back.className = 'btn block';
  back.textContent = 'Back to sign in';
  back.addEventListener('click', () => { back.remove(); $('tabbar').hidden = false; showAuth(); });
  $('about').append(back);
});

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  setMsg('authError');
  const next = {
    username: $('aUser').value.trim(),
    password: $('aPass').value,
    region: $('aRegion').value,
    remember: $('aRemember').checked,
  };
  if (!next.username || !next.password) return;
  $('authBtn').disabled = true;
  $('authBtn').textContent = 'Signing in…';
  try {
    // Prove the credentials and get the first day of readings in one go.
    const c = new DexcomClient(next);
    const rows = await c.readings(1440, 288);
    creds = { ...next, ...c.session };
    saveCreds(creds);
    client = c;
    await putReadings(rows);
    $('aPass').value = '';
    await enterApp();
  } catch (err) {
    setMsg('authError', signInMessage(err));
  } finally {
    $('authBtn').disabled = false;
    $('authBtn').textContent = 'Sign in';
  }
});

function signInMessage(err) {
  if (!(err instanceof DexcomError)) return 'Something went wrong. Try again.';
  if (err.isAuthError) {
    return 'Dexcom rejected that username or password. Use the account of the person wearing the sensor, not a follower\'s.';
  }
  return err.message;
}

async function enterApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  readings = await getReadings(nowMs() - DAY_MS);
  status = { state: readings.length ? 'ok' : 'none', message: '' };
  showTab('home');
  startPolling();
  fetchNow();
  pruneReadings();
  if (prefs.startBig || location.hash === '#big') enterBig(false);
}

// ---------------------------------------------------------------- tabs
function showTab(name) {
  tab = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const b of $('tabbar').children) b.classList.toggle('active', b.dataset.tab === name);
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'settings') renderSettings();
}
$('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) showTab(g.dataset.goto);
});

// ---------------------------------------------------------------- fetching
async function fetchNow() {
  if (fetching || !creds || status.state === 'auth') return;
  fetching = true;
  $('refreshBtn').classList.add('spin');
  try {
    client ??= new DexcomClient(creds, { accountId: creds.accountId, sessionId: creds.sessionId });
    const latest = readings[readings.length - 1];
    // Ask only for what we're missing (plus a little overlap), capped at Dexcom's 24 h window.
    const minutes = latest ? Math.min(1440, Math.max(15, Math.ceil((nowMs() - latest.t) / 60000) + 10)) : 1440;
    const rows = await client.readings(minutes, Math.min(288, Math.ceil(minutes / 5) + 2));
    lastFetch = nowMs();
    await putReadings(rows);
    const byT = new Map(readings.map(r => [r.t, r]));
    for (const r of rows) byT.set(r.t, r);
    const since = nowMs() - DAY_MS;
    readings = [...byT.values()].filter(r => r.t >= since).sort((a, b) => a.t - b.t);
    status = { state: 'ok', message: '' };

    const s = client.session;
    if (s.sessionId !== creds.sessionId || s.accountId !== creds.accountId) {
      creds = { ...creds, ...s };
      saveCreds(creds);
    }
  } catch (err) {
    if (err instanceof DexcomError && err.isAuthError) {
      // Stop here: retrying a bad password on a timer can lock the Dexcom account.
      status = { state: 'auth', message: err.message };
      client = null;
    } else {
      status = { state: 'error', message: err instanceof DexcomError ? err.message : "Can't reach Dexcom right now." };
    }
  } finally {
    fetching = false;
    $('refreshBtn').classList.remove('spin');
    renderAll();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && nowMs() - lastFetch >= POLL_MS - 1000) fetchNow();
  }, POLL_MS);
  ageTimer = setInterval(renderAll, 15000);
}
function stopPolling() { clearInterval(pollTimer); clearInterval(ageTimer); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('app').hidden) return;
  if (nowMs() - lastFetch > 30000) fetchNow();
  renderAll();
  if (!$('big').hidden) requestWakeLock();
});
window.addEventListener('online', () => { if (!$('app').hidden) fetchNow(); });

$('refreshBtn').addEventListener('click', () => { if (status.state === 'auth') showTab('settings'); else fetchNow(); });

function renderAll() {
  if ($('app').hidden) return;
  if (tab === 'home') renderHome();
  if (tab === 'settings') renderDataLine();
  if (!$('big').hidden) renderBig();
}

// ---------------------------------------------------------------- home
function latestInfo() {
  const latest = readings[readings.length - 1];
  if (!latest) return null;
  const stale = nowMs() - latest.t > STALE_MS;
  return {
    latest, stale,
    text: fmtGlucose(latest.v, prefs.useMmol),
    cls: glucoseClass(latest.v, prefs.low, prefs.high, stale),
    arrow: stale ? '' : (TREND_ARROWS[latest.trend] ?? ''),
    delta: fmtDelta(latest, readings[readings.length - 2], prefs.useMmol),
    age: fmtAge(nowMs() - latest.t),
  };
}

function showBanner(kind, msg, action) {
  const b = $('banner');
  b.hidden = !msg;
  b.className = 'banner' + (kind === 'err' ? ' err' : '');
  b.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button data-goto="settings">${esc(action)}</button>` : '');
}

function renderBanner() {
  if (status.state === 'auth') showBanner('warn', 'Dexcom rejected your sign-in. Sign in again to keep updating.', 'Settings');
  else if (status.state === 'error') showBanner('err', status.message || "Can't reach Dexcom right now. Showing saved readings.");
  else showBanner('warn', '');
}

function renderHome() {
  renderBanner();
  const info = latestInfo();
  const val = $('gVal');
  val.textContent = info ? info.text : '--';
  val.className = 'gval ' + (info ? info.cls : 'stale') + (info && /[A-Z]/.test(info.text) ? ' word' : '');
  $('gArrow').textContent = info ? info.arrow : '';
  $('gArrow').className = 'garrow ' + (info ? info.cls : '');
  $('gMeta').innerHTML = info
    ? [info.delta && `<b>${info.delta}</b>`, unitsLabel(prefs.useMmol), info.age].filter(Boolean).join(' · ')
    : (fetching ? 'Loading…' : 'No readings yet');

  for (const b of $('rangeTabs').children) b.classList.toggle('active', Number(b.dataset.h) === prefs.range);
  drawChart($('chart'), {
    readings, hours: prefs.range, now: nowMs(),
    low: prefs.low, high: prefs.high, mmol: prefs.useMmol,
  });
}

$('rangeTabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  prefs.range = Number(b.dataset.h);
  savePrefs(prefs);
  renderHome();
});
window.addEventListener('resize', () => { if (!$('app').hidden && tab === 'home') renderHome(); });

// ---------------------------------------------------------------- big mode
let wakeLock = null;
let barTimer = null;

// Safari on iPad only has the webkit-prefixed fullscreen API; iPhone has none.
const fsRoot = document.documentElement;
const fsEnabled = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsEnter = () => { try { return (fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen)?.call(fsRoot)?.catch?.(() => {}); } catch { /* not allowed */ } };
const fsExit = () => { try { return (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {}); } catch { /* ignore */ } };

/** Ask the browser to keep the screen on. The browser drops the lock when the page is hidden or
 *  the battery is low, so it's re-requested whenever it's released while big mode is still open. */
async function requestWakeLock() {
  if (!navigator.wakeLock || wakeLock || document.visibilityState !== 'visible' || $('big').hidden) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (!$('big').hidden) setTimeout(requestWakeLock, 1000);
    });
  } catch { /* unsupported or denied */ }
}

function showBar(ms = 5000) {
  $('bigBar').hidden = false;
  clearTimeout(barTimer);
  barTimer = setTimeout(() => { $('bigBar').hidden = true; }, ms);
}

function updateFsButton() {
  $('bigFs').hidden = !fsEnabled();
  $('bigFs').textContent = fsElement() ? 'Exit fullscreen' : 'Fullscreen';
}

/** `gesture` is true when the user just tapped, which browsers require before allowing fullscreen. */
function enterBig(gesture) {
  $('big').hidden = false;
  renderBig();
  updateFsButton();
  if (gesture) fsEnter();
  else showBar(10000);          // auto-started: show the controls so fullscreen is one tap away
  requestWakeLock();
}

function exitBig() {
  $('big').hidden = true;
  $('bigBar').hidden = true;
  clearTimeout(barTimer);
  if (fsElement()) fsExit();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (location.hash === '#big') history.replaceState(null, '', location.pathname + location.search);
}

function renderBig() {
  const info = latestInfo();
  const text = info ? info.text : '--';
  const main = document.querySelector('.big-main');
  main.className = 'big-main ' + (info ? info.cls : 'stale') + (/[A-Z]/.test(text) ? ' word' : '');
  main.style.setProperty('--n', text.replace('.', '').length + (text.includes('.') ? 0.4 : 0) + (info?.arrow ? 0 : -0.5));
  $('bigVal').textContent = text;
  $('bigArrow').textContent = info ? info.arrow : '';
  const parts = info ? [info.delta && `<b>${info.delta}</b>`, unitsLabel(prefs.useMmol), info.age] : ['No readings'];
  parts.push(fmtClock(nowMs()));
  $('bigInfo').innerHTML = parts.filter(Boolean).join(' · ');
}

$('bigBtn').addEventListener('click', () => enterBig(true));
$('bigIconBtn').addEventListener('click', () => enterBig(true));

// A tap shows or hides the controls. It never closes the display, so a stray tap on a wall tablet is harmless.
$('big').addEventListener('click', e => {
  if (e.target.closest('.big-bar')) return;
  if ($('bigBar').hidden) showBar(); else { $('bigBar').hidden = true; clearTimeout(barTimer); }
});
$('bigClose').addEventListener('click', exitBig);
$('bigFs').addEventListener('click', () => { if (fsElement()) fsExit(); else fsEnter(); showBar(); });
// Leaving fullscreen (Back, Esc) keeps big mode open; only Close ends it.
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, updateFsButton);

// ---------------------------------------------------------------- settings
function renderSettings() {
  setMsg('sError');
  $('sUnits').value = prefs.useMmol ? 'mmol' : 'mgdl';
  $('sLow').value = fmtGlucoseNum(prefs.low, prefs.useMmol);
  $('sHigh').value = fmtGlucoseNum(prefs.high, prefs.useMmol);
  $('acctLine').textContent = creds
    ? `Signed in as ${creds.username}${creds.remember ? '' : ' (this tab only)'}.`
    : 'Not signed in.';
  $('ver').textContent = `v${VERSION}`;
  $('sStartBig').checked = !!prefs.startBig;
  $('wakeStatus').textContent = navigator.wakeLock
    ? 'Stay awake: this browser can keep the screen on while big mode is open.'
    : "Stay awake: this browser can't keep the screen on. Set the device's screen timeout to Never.";
  $('fsStatus').textContent = fsEnabled()
    ? 'Fullscreen: supported. Use the Fullscreen button in big mode.'
    : 'Fullscreen: not supported here. Add the app to your home screen to hide the browser bars.';
  renderDataLine();
}

$('sStartBig').addEventListener('change', e => { prefs.startBig = e.target.checked; savePrefs(prefs); });

function renderDataLine() {
  if (!readings.length) { $('dataLine').textContent = 'No readings stored on this device yet.'; return; }
  $('dataLine').textContent = `${readings.length} readings from the last 24 hours are shown. Older readings are kept on this device for up to 90 days.`;
}

$('sUnits').addEventListener('change', e => {
  prefs.useMmol = e.target.value === 'mmol';
  savePrefs(prefs);
  renderSettings();
  $('sUnits').focus();
});

function limitInput(key, other, isLow) {
  return e => {
    const n = parseNum(e.target.value);
    if (n == null) return;
    const mg = Math.round(n * (prefs.useMmol ? MMOL : 1));
    const ok = mg >= 40 && mg <= 400 && (isLow ? mg < prefs[other] : mg > prefs[other]);
    if (!ok) return setMsg('sError', 'Low must be below high, between 40 and 400 mg/dL.');
    setMsg('sError');
    prefs[key] = mg;
    savePrefs(prefs);
  };
}
$('sLow').addEventListener('input', limitInput('low', 'high', true));
$('sHigh').addEventListener('input', limitInput('high', 'low', false));
$('sLow').addEventListener('change', renderSettings);
$('sHigh').addEventListener('change', renderSettings);

$('signOutBtn').addEventListener('click', () => {
  clearCreds();
  creds = null; client = null;
  status = { state: 'none', message: '' };
  stopPolling();
  showAuth();
});

$('storedBtn').addEventListener('click', async () => {
  const box = $('storedBox');
  if (!box.hidden) { box.hidden = true; $('storedBtn').textContent = "Show what's stored"; return; }
  box.textContent = await describeStorage();
  box.hidden = false;
  $('storedBtn').textContent = 'Hide';
});

$('csvBtn').addEventListener('click', async () => {
  const rows = await getReadings(0);
  if (!rows.length) return toast('No readings to download.', true);
  const lines = ['time_iso,mgdl,mmol,trend'];
  for (const r of rows) lines.push(`${new Date(r.t).toISOString()},${r.v},${(r.v / MMOL).toFixed(1)},${r.trend}`);
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'glucoseanywhere-readings.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('forgetBtn').addEventListener('click', async () => {
  if (!confirm('Remove your sign-in, readings and settings from this device?')) return;
  stopPolling();
  await forgetEverything();
  creds = null; client = null; readings = [];
  prefs = loadPrefs();
  status = { state: 'none', message: '' };
  showAuth();
  toast('Everything was removed from this device.');
});

// ---------------------------------------------------------------- install
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('installCard').hidden = false;
});
window.addEventListener('appinstalled', () => { installEvent = null; $('installCard').hidden = true; });
$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $('installCard').hidden = true;
});

// ---------------------------------------------------------------- boot
function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  for (const el of document.querySelectorAll('input[inputmode=decimal]')) {
    el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
  }
  creds = loadCreds();
  if (creds) enterApp(); else showAuth();
}
boot();
