import { DexcomClient, DexcomError } from './dexcom.js';
import { drawChart, chartFills } from './chart.js';
import {
  loadPrefs, savePrefs, loadCreds, saveCreds, clearCreds,
  putReadings, getReadings, pruneReadings, forgetEverything, describeStorage,
  noteVisit, feedbackDue, dismissFeedback,
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

if (!['auto', 'light', 'dark'].includes(prefs.theme)) prefs.theme = 'auto';
if (!['standard', 'chart'].includes(prefs.layout)) prefs.layout = 'standard';

// ---------------------------------------------------------------- theme
// Colours live in CSS variables (app.css), so switching themes only has to set data-theme.
// theme.js does the same thing before first paint; this keeps it in sync after a change.
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');
const THEME_COLOR = { light: '#F4F5F7', dark: '#16181D' };

function applyTheme() {
  if (prefs.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', prefs.theme);
  const effective = prefs.theme === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : prefs.theme;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_COLOR[effective]);
}
lightQuery.addEventListener?.('change', applyTheme);
applyTheme();

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
  setTimeout(syncWakeLock, 0);
  $('app').hidden = true;
  $('auth').hidden = false;
  setMsg('authError', message);
}

for (const link of document.querySelectorAll('[data-verify]')) link.addEventListener('click', e => {
  e.preventDefault();
  $('auth').hidden = true;
  $('app').hidden = false;
  openSettings();
  $('about').scrollIntoView();
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
  if (location.hash === '#chart') setLayout('chart');
  if (prefs.startBig || location.hash === '#big') enterBig(false);
}

// ---------------------------------------------------------------- layout
/** Standard: big reading beside/above the chart. Chart: small reading in a header, graph fills the rest. */
function applyLayout() {
  const chart = prefs.layout === 'chart';
  $('view-home').classList.toggle('chart-focus', chart);
  $('layoutBtn').setAttribute('aria-label', chart ? 'Switch to the reading view' : 'Switch to chart view');
  $('layoutBtn').title = chart ? 'Reading view (C)' : 'Chart view (C)';
  $('fsBtn').hidden = !(chart && fsEnabled());
  if (!$('app').hidden && tab === 'home') renderHome();
  syncWakeLock();
}
function setLayout(layout) {
  prefs.layout = layout;
  savePrefs(prefs);
  applyLayout();
}
$('layoutBtn').addEventListener('click', () => setLayout(prefs.layout === 'chart' ? 'standard' : 'chart'));
$('fsBtn').addEventListener('click', () => { if (fsElement()) fsExit(); else fsEnter(); });

// ---------------------------------------------------------------- tabs
function showTab(name) {
  tab = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'settings') renderSettings();
  syncWakeLock();
}
// Settings is a page you open and close, not a tab. Opening adds a history entry, so the device's
// Back button (and the browser's) closes it instead of leaving the app.
function openSettings() {
  if (tab === 'settings') return;
  history.pushState({ ga: 'settings' }, '');
  showTab('settings');
}
function leaveSettings() {
  if (!creds) showAuth(); else showTab('home');
}
function closeSettings() {
  if (history.state?.ga === 'settings') history.back();   // popstate then leaves the page
  else leaveSettings();
}
window.addEventListener('popstate', () => { if (tab === 'settings') leaveSettings(); });
$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g && g.dataset.goto === 'settings') openSettings();
  if (e.target.closest('[data-fb], [data-fb-dismiss]')) { dismissFeedback(); setTimeout(renderBanner); }   // after the click, so the mailto: link isn't removed first
});

// ---------------------------------------------------------------- fetching
async function fetchNow() {
  noteVisit();   // an always-on screen never restarts, so count each day here rather than only at start-up
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
  syncWakeLock();
});
window.addEventListener('online', () => { if (!$('app').hidden) fetchNow(); });

$('refreshBtn').addEventListener('click', () => { if (status.state === 'auth') openSettings(); else fetchNow(); });

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
  else if (feedbackDue() && nowMs() - lastTouch < FEEDBACK_ACTIVE_MS) showFeedbackPrompt();
  else showBanner('warn', '');
}

// Shown only when there's nothing wrong to report, so it never hides a sign-in or connection problem, and only
// while someone has touched the app in the last few minutes, so an unattended wall display never shows it.
// It's one ask: it goes away by itself after 30 seconds and doesn't come back.
const FEEDBACK_ACTIVE_MS = 3 * 60e3, FEEDBACK_SHOWN_MS = 30e3;
let feedbackTimer = null;

function showFeedbackPrompt() {
  feedbackTimer ??= setTimeout(() => { dismissFeedback(); renderBanner(); }, FEEDBACK_SHOWN_MS);
  const b = $('banner');
  b.hidden = false;
  b.className = 'banner info';
  b.innerHTML = '<span>Finding GlucoseAnywhere useful? Tell me what to improve.</span>' +
    '<span class="banner-actions"><a class="btn-link" data-fb href="mailto:feedback@glucoseanywhere.com?subject=GlucoseAnywhere%20feedback">Send feedback</a>' +
    '<button data-fb-dismiss>Not now</button></span>';
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
// On a desktop window the chart fills its card, so redraw whenever that box changes size.
if ('ResizeObserver' in window) {
  new ResizeObserver(() => { if (!$('app').hidden && tab === 'home' && chartFills()) renderHome(); }).observe($('chart'));
}

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
// Stay awake (a setting of its own) applies to the two display views: big number and chart view.
const wantAwake = () => !$('app').hidden && prefs.stayAwake && (!$('big').hidden || (prefs.layout === 'chart' && tab === 'home'));

async function requestWakeLock() {
  if (!navigator.wakeLock || wakeLock || document.visibilityState !== 'visible' || !wantAwake()) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (wantAwake()) setTimeout(requestWakeLock, 1000);
    });
  } catch { /* unsupported or denied */ }
}

/** Take or drop the screen wake lock to match what the current view needs. */
function syncWakeLock() {
  if (wantAwake()) requestWakeLock();
  else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
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

/** Opens the big number in the window. It never goes fullscreen by itself: the Fullscreen button
 *  (or the F key) does that on request. The controls show briefly so that option is discoverable,
 *  and longer when the app started in big mode on its own. */
function enterBig(userOpened) {
  $('big').hidden = false;
  renderBig();
  updateFsButton();
  showBar(userOpened ? 3000 : 10000);
  syncWakeLock();
}

function exitBig() {
  $('big').hidden = true;
  $('bigBar').hidden = true;
  clearTimeout(barTimer);
  if (fsElement()) fsExit();
  syncWakeLock();
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
  $('sTheme').value = prefs.theme;
  $('sUnits').value = prefs.useMmol ? 'mmol' : 'mgdl';
  $('sLow').value = fmtGlucoseNum(prefs.low, prefs.useMmol);
  $('sHigh').value = fmtGlucoseNum(prefs.high, prefs.useMmol);
  $('acctLine').textContent = creds
    ? `Signed in as ${creds.username}${creds.remember ? '' : ' (this tab only)'}.`
    : 'Not signed in.';
  $('ver').textContent = `v${VERSION}`;
  $('sStartBig').checked = !!prefs.startBig;
  $('sLayout').value = prefs.layout;
  $('sStayAwake').checked = !!prefs.stayAwake;
  $('sStayAwake').disabled = !navigator.wakeLock;
  $('wakeStatus').textContent = navigator.wakeLock
    ? 'This browser can keep the screen on while the big number or chart view is open.'
    : "This browser can't keep the screen on, so Stay awake is unavailable. Set the device's screen timeout to Never instead.";
  $('fsStatus').textContent = fsEnabled()
    ? 'Fullscreen: supported. Use the Fullscreen button in big mode.'
    : 'Fullscreen: not supported here. Add the app to your home screen to hide the browser bars.';
  renderDataLine();
}

$('sStartBig').addEventListener('change', e => { prefs.startBig = e.target.checked; savePrefs(prefs); });
$('sLayout').addEventListener('change', e => setLayout(e.target.value));
$('sStayAwake').addEventListener('change', e => { prefs.stayAwake = e.target.checked; savePrefs(prefs); syncWakeLock(); });

function renderDataLine() {
  if (!readings.length) { $('dataLine').textContent = 'No readings stored on this device yet.'; return; }
  $('dataLine').textContent = `${readings.length} readings from the last 24 hours are shown. Older readings are kept on this device for up to 90 days.`;
}

$('sTheme').addEventListener('change', e => {
  prefs.theme = e.target.value;
  savePrefs(prefs);
  applyTheme();
});

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

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || $('app').hidden) return;
  if (e.target.closest?.('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  const bigOpen = !$('big').hidden;
  if (tab === 'settings') { if (key === 'escape') closeSettings(); return; }
  if (key === 'escape') {
    if (bigOpen && !fsElement()) exitBig();      // the first Esc leaves fullscreen (the browser handles it)
  } else if (key === 's' && !bigOpen) {
    openSettings();
  } else if (key === 'c' && !bigOpen) {
    setLayout(prefs.layout === 'chart' ? 'standard' : 'chart');
  } else if (key === 'b') {
    if (bigOpen) exitBig(); else enterBig(true);
  } else if (key === 'f') {
    if (!bigOpen && prefs.layout !== 'chart') enterBig(true);
    if (fsElement()) fsExit(); else fsEnter();
  } else if (key === 'r' && !bigOpen) {
    if (status.state === 'auth') openSettings(); else fetchNow();
  }
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

// ---------------------------------------------------------------- updates
// A screen that stays on all day never reloads, so it would run old code forever. Every hour (and when the
// app comes back to the foreground) compare the ETags of the app's files with the ones seen at start-up.
// When they differ, reload: straight away if the app is in the background, otherwise after a minute with
// no touches, back into big-number mode if that's where it was. Saved sign-in and readings are untouched.
const UPDATE_FILES = ['./', 'app.js', 'store.js', 'dexcom.js', 'chart.js', 'format.js', 'theme.js', 'app.css'];
const UPDATE_CHECK_MS = 3600e3, UPDATE_IDLE_MS = 60e3;
let versionTag = null, lastTouch = nowMs(), updateTimer = null;

async function currentVersionTag() {
  try {
    const tags = await Promise.all(UPDATE_FILES.map(async f => {
      const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
      const tag = r.ok && r.headers.get('etag');
      if (!tag) throw new Error('no etag');
      return tag;
    }));
    return tags.join();
  } catch { return null; }   // offline, or a host that sends no ETags: try again next time
}

function reloadForUpdate() {
  if (!$('big').hidden) location.hash = '#big';
  location.reload();
}

function applyUpdateWhenIdle() {
  if (updateTimer) return;
  updateTimer = setInterval(() => {
    if (document.visibilityState === 'hidden' || nowMs() - lastTouch > UPDATE_IDLE_MS) reloadForUpdate();
  }, 5000);
}

async function checkForUpdate() {
  const tag = await currentVersionTag();
  if (!tag) return;
  if (versionTag === null) versionTag = tag;
  else if (tag !== versionTag) applyUpdateWhenIdle();
}

for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { lastTouch = nowMs(); }, true);
setInterval(checkForUpdate, UPDATE_CHECK_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

// ---------------------------------------------------------------- boot
function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  for (const el of document.querySelectorAll('input[inputmode=decimal]')) {
    el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
  }
  checkForUpdate();
  applyLayout();
  creds = loadCreds();
  if (creds) enterApp(); else showAuth();
}
boot();
