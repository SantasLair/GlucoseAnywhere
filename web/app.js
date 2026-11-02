import { DexcomClient, DexcomError } from './dexcom.js';
import { drawChart, drawIobChart, chartFills } from './chart.js';
import { configured, connect, finishSignIn, disconnect, connectedTo, syncNow, noteDeleted, needsReconnect, PROVIDERS } from './sync.js';
import { curveParams, iobAt, iobFraction, cobAt, iobSeries, activityAt, activitySeries, wizardReady, wizard } from './insulin.js';
import {
  loadPrefs, savePrefs, loadCreds, saveCreds, clearCreds,
  putReadings, getReadings, pruneReadings, forgetEverything, describeStorage,
  putTreatments, getTreatments, deleteTreatment, requestPersistence, cleanTreatment,
  noteVisit, feedbackDue, dismissFeedback, DEFAULT_PREFS,
} from './store.js';
import { offerSettings, applyRemote } from './settings.js';
import {
  MMOL, TREND_ARROWS, STALE_MS, unitsLabel, fmtGlucose, fmtGlucoseNum, parseNum,
  fmtDelta, glucoseClass, fmtAge, fmtClock, esc,
} from './format.js';

const VERSION = '1.5.0';
const DAY_MS = 24 * 3600e3;
const POLL_MS = 60e3;          // check once a minute; Dexcom produces a reading every 5
const $ = id => document.getElementById(id);
for (const el of document.querySelectorAll('.ver')) el.textContent = `v${VERSION}`;   // Settings title, About, and the sign-in page

// ---------------------------------------------------------------- state
let prefs = loadPrefs();
if (![3, 6, 12, 24].includes(prefs.range)) prefs.range = 6;
let creds = null;            // { username, password, region, remember, accountId?, sessionId? }
let client = null;
let readings = [];           // last 24 h, oldest first
let treatments = [];         // insulin and carb log, last 24 h, oldest first: { id, t, kind, v }
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
  document.body.classList.remove('has-nav');
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
  treatments = await getTreatments(nowMs() - DAY_MS);
  loadRecentExtras().then(() => { if (tab === 'insulin') renderInsulin(); });
  applyInsulinOptional();
  if (prefs.insulinOn) requestPersistence();
  runSync();
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
  updateNav();
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
/** The phone's bottom bar shows on every main page, but not in the wall-display chart view or on the sign-in page. */
function updateNav() {
  const show = !$('app').hidden && !(tab === 'home' && prefs.layout === 'chart');
  $('tabBar').hidden = !show;
  document.body.classList.toggle('has-nav', show);
  for (const b of $('tabBar').children) b.classList.toggle('active', b.dataset.act === tab);
}

function showTab(name) {
  tab = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'settings') renderSettings();
  if (name === 'insulin') openInsulinPage();
  if (name === 'log') openLogPage();
  updateNav();
  syncWakeLock();
}
// Settings and Insulin are pages you open and close, not tabs. Opening adds a history entry, so the device's
// Back button (and the browser's) closes it instead of leaving the app.
function openPage(name) {
  if (tab === name) return;
  history.pushState({ ga: name }, '');
  showTab(name);
}
const openSettings = () => openPage('settings');
const openInsulin = () => { if (prefs.insulinOn) openPage('insulin'); };
const openLog = () => { if (prefs.insulinOn) openPage('log'); };
function leavePage() {
  if (!creds) showAuth(); else showTab('home');
}
function closePage() {
  if (history.state?.ga === tab) history.back();   // popstate then leaves the page
  else leavePage();
}
window.addEventListener('popstate', () => { if (tab !== 'home') leavePage(); });
$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closePage);
$('insulinBtn').addEventListener('click', openInsulin);
$('insulinClose').addEventListener('click', closePage);
$('logBtn').addEventListener('click', openLog);
$('logClose').addEventListener('click', closePage);
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g && g.dataset.goto === 'settings') openSettings();
  if (e.target.closest('[data-dismiss-notice]')) { prefs.settingsNotice = []; savePrefs(prefs); renderBanner(); }
  if (e.target.closest('[data-fb], [data-fb-dismiss]')) setTimeout(hideFeedbackPrompt);   // after the click, so the mailto: link isn't removed first
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
  if (connectedTo()) syncSoon();
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
  if (tab === 'insulin') renderInsulin();
  if (tab === 'log') { renderQuick(); renderRecent(); }
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

function showSettingsNotice() {
  const b = $('banner');
  b.hidden = false;
  b.className = 'banner';
  b.innerHTML = `<span>Settings updated from another device: ${esc(prefs.settingsNotice.join('; '))}</span>` +
    '<span class="banner-actions"><button data-goto="settings">Review</button><button data-dismiss-notice>OK</button></span>';
}

function renderBanner() {
  if (status.state === 'auth') showBanner('warn', 'Dexcom rejected your sign-in. Sign in again to keep updating.', 'Settings');
  else if (status.state === 'error') showBanner('err', status.message || "Can't reach Dexcom right now. Showing saved readings.");
  else if (prefs.settingsNotice?.length) showSettingsNotice();
  else if (feedbackOnScreen || (feedbackDue() && nowMs() - lastTouch < FEEDBACK_ACTIVE_MS)) showFeedbackPrompt();
  else showBanner('warn', '');
}

// Shown only when there's nothing wrong to report, so it never hides a sign-in or connection problem, and only
// while someone has touched the app in the last few minutes, so an unattended wall display never shows it.
// It's one ask: it's recorded as done the moment it first appears, so a reload, a missed prompt or a closed
// tab never brings it back. It goes away by itself after 30 seconds, or when either button is tapped.
const FEEDBACK_ACTIVE_MS = 3 * 60e3, FEEDBACK_SHOWN_MS = 30e3;
let feedbackOnScreen = false, feedbackTimer = null;

function hideFeedbackPrompt() {
  clearTimeout(feedbackTimer);
  feedbackOnScreen = false;
  renderBanner();
}

function showFeedbackPrompt() {
  if (!feedbackOnScreen) {
    feedbackOnScreen = true;
    dismissFeedback();
    feedbackTimer = setTimeout(hideFeedbackPrompt, FEEDBACK_SHOWN_MS);
  }
  const b = $('banner');
  b.hidden = false;
  b.className = 'banner info';
  b.innerHTML = '<span>Finding GlucoseAnywhere useful? Tell me what to improve.</span>' +
    '<span class="banner-actions"><a class="btn-link" data-fb href="mailto:feedback@glucoseanywhere.com?subject=GlucoseAnywhere%20feedback">Send feedback</a>' +
    '<button data-fb-dismiss>Not now</button></span>';
}

// A phone held upright shows the home screen as one card, with the insulin figures in a bar at the bottom.
const phoneQuery = window.matchMedia('(max-width: 600px) and (orientation: portrait)');
phoneQuery.addEventListener?.('change', () => { if (!$('app').hidden && tab === 'home') renderHome(); });

function renderHomeBar() {
  const show = prefs.insulinOn;
  $('homeBar').hidden = !show;
  if (!show) return;
  $('hbIob').textContent = fmtU(iobAt(doses(), nowMs(), curve()));
  const w = wizardNow();
  $('hbSuggestBox').hidden = !(w && w.units > 0);
  if (w) $('hbSuggest').textContent = fmtDose(w.units);
}
$('homeBar').addEventListener('click', openInsulin);
$('homeBar').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInsulin(); } });

// The bottom bar on a phone (fixed to the screen on every main page) does what the icon row does on a bigger screen.
// Moving between pages from the bar replaces the history entry, so Back or the close button still returns to Home.
function navTo(name) {
  if ((name === 'insulin' || name === 'log') && !prefs.insulinOn) return;
  if (name === 'home') { if (tab !== 'home') closePage(); return; }
  if (tab === 'home') return openPage(name);
  if (tab === name) return;
  history.replaceState({ ga: name }, '');
  showTab(name);
}
$('tabBar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  ({
    home: () => navTo('home'),
    insulin: () => navTo('insulin'),
    log: () => navTo('log'),
    chart: () => { if (tab !== 'home') closePage(); setLayout('chart'); },
    big: () => enterBig(true),
    settings: () => navTo('settings'),
  })[b.dataset.act]?.();
});

// Refresh has no button on the phone layout: pull down on the reading, or tap the line under it.
let pullY = null;
$('view-home').addEventListener('touchstart', e => {
  pullY = phoneQuery.matches && prefs.layout !== 'chart' && e.touches[0].clientY < window.innerHeight * 0.5 ? e.touches[0].clientY : null;
}, { passive: true });
$('view-home').addEventListener('touchend', e => {
  if (pullY == null) return;
  const dy = e.changedTouches[0].clientY - pullY;
  pullY = null;
  if (dy > 90) { toast('Refreshing…'); $('refreshBtn').click(); }
}, { passive: true });
$('gMeta').addEventListener('click', () => { if (phoneQuery.matches && prefs.layout !== 'chart') $('refreshBtn').click(); });

function renderHome() {
  renderHomeBar();
  renderBanner();
  const info = latestInfo();
  const val = $('gVal');
  val.textContent = info ? info.text : '--';
  val.className = 'gval ' + (info ? info.cls : 'stale') + (info && /[A-Z]/.test(info.text) ? ' word' : '');
  $('gArrow').textContent = info ? info.arrow : '';
  $('gArrow').className = 'garrow ' + (info ? info.cls : '');
  $('gMeta').innerHTML = info
    ? [info.delta && `<b>${info.delta}</b>`, unitsLabel(prefs.useMmol), info.age, ...insulinBits()].filter(Boolean).join(' · ')
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

// ---------------------------------------------------------------- insulin
/** Show or hide everything insulin-related to match the opt-in switch. */
function applyInsulinOptional() {
  $('insulinBtn').hidden = !prefs.insulinOn;
  $('tbInsulin').hidden = !prefs.insulinOn;
  $('tbLog').hidden = !prefs.insulinOn;
  $('logBtn').hidden = !prefs.insulinOn;
  $('insulinBody').hidden = !prefs.insulinOn;
  $('sInsulinOn').checked = !!prefs.insulinOn;
  if (!prefs.insulinOn && (tab === 'insulin' || tab === 'log')) closePage();
  updateNav();
  if (!$('app').hidden && tab === 'home') renderHome();
}
$('sInsulinOn').addEventListener('change', e => {
  prefs.insulinOn = e.target.checked;
  savePrefs(prefs);
  applyInsulinOptional();
  if (prefs.insulinOn) { requestPersistence(); runSync(); }
});

const insulinSettings = () => ({
  icr: prefs.icr, isf: prefs.isf, target: prefs.target,
  step: prefs.step || 0.5, maxBolus: prefs.maxBolus || 10,
});
const curve = () => curveParams(prefs.peak || 75, (prefs.dia || 5) * 60);
const doses = () => treatments.filter(r => r.kind === 'insulin');
const meals = () => treatments.filter(r => r.kind === 'carbs');
const fmtU = v => (Math.round(v * 100) / 100).toFixed(2);
const fmtDose = v => String(Math.round(v * 100) / 100);

let wBgEdited = false;   // the BG tile follows the sensor until the user types in it

/** BG for the wizard in mg/dL: what's typed in the tile if edited, else the sensor if it's current. */
function wizardBg(useTile) {
  if (useTile && wBgEdited) {
    const n = parseNum($('wBg').value);
    const v = n == null ? null : Math.round(n * (prefs.useMmol ? MMOL : 1));
    return { v: v != null && v >= 20 && v <= 600 ? v : null, src: 'manual' };
  }
  const info = latestInfo();
  return info && !info.stale && info.latest.v >= 40 && info.latest.v <= 400 ? { v: info.latest.v, src: 'cgm', info } : { v: null, src: 'none' };
}

/** The wizard's answer, or null when it isn't set up or there is nothing to base a dose on.
 *  useTile: take BG from the Bolus screen's tile; otherwise it's the sensor reading (the home line). */
function wizardNow(carbs = 0, useTile = false) {
  if (!wizardReady(prefs)) return null;
  const bg = wizardBg(useTile);
  if (bg.v == null && !(carbs > 0)) return null;
  return { ...wizard({ bg: bg.v, carbs, iob: iobAt(doses(), nowMs(), curve()) }, insulinSettings()), bg };
}

/** Extra items for the home screen's reading line: insulin on board, and the suggestion if there is one. */
function insulinBits() {
  if (!prefs.insulinOn || phoneQuery.matches) return [];   // on a phone the bottom bar shows these
  if (!treatments.length && !wizardReady(prefs)) return [];
  const bits = [`IOB ${fmtU(iobAt(doses(), nowMs(), curve()))} u`];
  const w = wizardNow();
  if (w && w.units > 0) bits.push(`<b>Suggest ${fmtDose(w.units)} u</b>`);
  return bits;
}

let lastBasal = null, lastMed = {};
/** The newest long-acting dose and the last time each medication was taken, looking back a week. */
async function loadRecentExtras() {
  const rows = await getTreatments(nowMs() - 7 * DAY_MS);
  lastBasal = rows.filter(r => r.kind === 'basal').at(-1) ?? null;
  lastMed = {};
  for (const r of rows) if (r.kind === 'med') lastMed[r.name] = Math.max(lastMed[r.name] ?? 0, r.t);
}

function renderQuick() {
  const buttons = prefs.medButtons ?? [];
  $('quickCard').hidden = !buttons.length;
  const now = nowMs();
  $('quickBtns').innerHTML = buttons.map((m, i) => {
    const t = lastMed[m.label], done = t && now - t < 12 * 3600e3;
    const sub = done ? `taken ${fmtClock(t)}` : m.items.join(', ');
    return `<button class="quick-btn${done ? ' done' : ''}" data-med="${i}">${done ? '✓ ' : ''}${esc(m.label)}${sub ? `<br><span class="when">${esc(sub)}</span>` : ''}</button>`;
  }).join('');
}
$('quickBtns').addEventListener('click', async e => {
  const b = e.target.closest('[data-med]');
  if (!b) return;
  const m = (prefs.medButtons ?? [])[Number(b.dataset.med)];
  if (!m) return;
  const name = m.label, last = lastMed[name], now = nowMs();
  if (last && now - last < 4 * 3600e3 && !confirm(`You logged ${name} at ${fmtClock(last)}. Log it again?`)) return;
  const rows = await putTreatments([{ t: now, kind: 'med', name, items: [...m.items], v: 1 }]);
  lastMed[name] = now;
  treatments = [...treatments, ...rows].sort((x, y) => x.t - y.t);
  if (logRange === 'all') allRows = await getTreatments(0);
  renderInsulin();
  syncSoon();
  toast(`Logged: ${name}.`);
});

function openLogPage() {
  setMsg('logError');
  hideEdit();
  resetLogTime();
  renderQuick();
  renderRecent();
}

function openInsulinPage() {
  wBgEdited = false;
  $('wCarbs').value = '';
  setMsg('logError');
  resetLogTime();
  renderInsulin();
}

const pad = n => String(n).padStart(2, '0');
const toLocalInput = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
let logTimeEdited = false;
function resetLogTime() { $('lTime').value = toLocalInput(nowMs()); logTimeEdited = false; }
$('lTime').addEventListener('input', () => { logTimeEdited = true; });

$('iobGraphOn').addEventListener('change', e => { prefs.iobGraph = e.target.checked; savePrefs(prefs); renderInsulin(); });
$('iobKind').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  prefs.iobKind = b.dataset.k;
  savePrefs(prefs);
  renderInsulin();
});

function renderInsulin() {
  const now = nowMs(), c = curve();
  $('iobVal').textContent = fmtU(iobAt(doses(), now, c));
  $('cobVal').textContent = Math.round(cobAt(meals(), now, prefs.carbHours || 3));
  const act = activityAt(doses(), now, c);
  $('actNow').textContent = act > 0.005
    ? `Working now: ${fmtU(act)} u/h${prefs.isf > 0 ? `, lowering glucose about ${fmtGlucoseNum(act * prefs.isf, prefs.useMmol)} ${unitsLabel(prefs.useMmol)} per hour` : ''}.`
    : 'No insulin working right now.';
  $('iobGraphOn').checked = !!prefs.iobGraph;
  $('iobGraphBox').hidden = !prefs.iobGraph;
  if (prefs.iobGraph) {
    const kind = prefs.iobKind === 'activity' ? 'activity' : 'iob';
    for (const b of $('iobKind').children) b.classList.toggle('active', b.dataset.k === kind);
    const start = now - 3 * 3600e3, end = now + 5 * 3600e3;
    drawIobChart($('iobChart'), {
      kind, series: (kind === 'iob' ? iobSeries : activitySeries)(doses(), start, end, c),
      insulin: doses(), carbs: meals(), start, end, now,
    });
    $('iobKey').innerHTML = (kind === 'iob'
      ? '<span class="key key-iob"></span>Insulin on board (still to work)'
      : '<span class="key key-act"></span>Activity (how fast it is working)') +
      ' <span class="key key-dose"></span>Dose <span class="key key-carb"></span>Carbs';
  }
  $('lastLong').hidden = !lastBasal;
  if (lastBasal) $('lastLong').textContent = `Last long-acting: ${fmtDose(lastBasal.v)} u at ${whenLabel(lastBasal.t)} (${fmtAge(now - lastBasal.t)}). Not counted in insulin on board.`;
  renderQuick();
  renderWizard();
  renderRecent();
}

function renderWizard() {
  const ready = wizardReady(prefs);
  $('wizSetup').hidden = ready;
  $('wizBody').hidden = !ready;
  if (!ready) return;
  const carbs = Math.max(0, parseNum($('wCarbs').value) ?? 0);
  $('wBgUnit').textContent = unitsLabel(prefs.useMmol);
  if (!wBgEdited) {
    const cgm = wizardBg(false);
    $('wBg').value = cgm.v == null ? '' : fmtGlucoseNum(cgm.v, prefs.useMmol);
  }
  const w = wizardNow(carbs, true);
  const bg = w?.bg ?? wizardBg(true);
  $('wBgSrc').textContent = wBgEdited ? '(entered)' : bg.src === 'cgm' ? `(sensor, ${bg.info.age})` : '(no current reading)';
  $('wBgReset').hidden = !wBgEdited;

  const row = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
  const sign = v => `${v < 0 ? '−' : '+'}${fmtU(Math.abs(v))} u`;
  let rows = '';
  if (w) {
    rows += row(`Food${carbs ? ` (${fmtDose(carbs)} g)` : ''}`, `${fmtU(w.meal)} u`);
    rows += row(`Correction${bg.v != null ? ` (${fmtGlucoseNum(bg.v, prefs.useMmol)} vs ${fmtGlucoseNum(prefs.target, prefs.useMmol)})` : ''}`, sign(w.correction));
    rows += row('Insulin on board', `−${fmtU(w.iob)} u`);
    rows += row('Total', `${fmtU(Math.max(0, w.raw))} u`, 'total');
  }
  $('wizRows').innerHTML = rows;
  $('wizUnits').textContent = w ? fmtDose(w.units) : '--';
  $('wizLog').disabled = !w;

  let warn = '';
  if (!w) warn = 'Enter carbs or a BG to calculate.';
  else if (bg.v != null && bg.v < prefs.low) warn = 'BG is below your low limit. Treat the low before dosing.';
  else if (bg.v == null) warn = 'No BG, so this dose is for food only.';
  else if (w.capped) warn = `Capped at your max bolus of ${fmtDose(prefs.maxBolus)} u.`;
  else if (w.raw < 0 && !carbs) warn = 'No dose: insulin on board covers the correction, or BG is under target.';
  $('wizWarn').textContent = warn;
}
$('wCarbs').addEventListener('input', renderWizard);
$('wBg').addEventListener('input', () => { wBgEdited = true; renderWizard(); });
$('wBgReset').addEventListener('click', () => { wBgEdited = false; renderWizard(); });

$('wizLog').addEventListener('click', () => {
  const carbs = Math.max(0, parseNum($('wCarbs').value) ?? 0);
  const w = wizardNow(carbs, true);
  if (!w) return;
  $('lType').value = 'rapid';
  $('lIns').value = w.units ? fmtDose(w.units) : '';
  $('lCarbs').value = carbs || '';
  navTo('log');
  $('logCard').scrollIntoView({ block: 'center' });
  $('lIns').focus();
});

$('logForm').addEventListener('submit', async e => {
  e.preventDefault();
  const ins = parseNum($('lIns').value) ?? 0, carbs = parseNum($('lCarbs').value) ?? 0;
  const long = $('lType').value === 'long';
  const t = logTimeEdited ? new Date($('lTime').value).getTime() : nowMs();
  if (!(ins > 0) && !(carbs > 0)) return setMsg('logError', 'Enter insulin units, carbs, or both.');
  if (ins < 0 || carbs < 0 || ins > (long ? 300 : 100) || carbs > 500) return setMsg('logError', `Those amounts look wrong. Insulin up to ${long ? 300 : 100} u, carbs up to 500 g.`);
  if (!Number.isFinite(t) || t > nowMs() + 5 * 60e3) return setMsg('logError', 'Choose a time that is not in the future.');
  if (t < nowMs() - DAY_MS) return setMsg('logError', 'Entries older than 24 hours are not shown, so choose a more recent time.');
  setMsg('logError');
  const rows = await putTreatments([
    ...(ins > 0 ? [{ t, kind: long ? 'basal' : 'insulin', v: ins }] : []),
    ...(carbs > 0 ? [{ t, kind: 'carbs', v: carbs }] : []),
  ]);
  treatments = [...treatments, ...rows].sort((a, b) => a.t - b.t);
  if (logRange === 'all') allRows = await getTreatments(0);
  $('lIns').value = $('lCarbs').value = $('wCarbs').value = '';
  $('lType').value = 'rapid';
  await loadRecentExtras();
  wBgEdited = false;
  resetLogTime();
  renderInsulin();
  syncSoon();
  toast('Saved.');
});

// The log: the last 24 hours, or everything ever logged. Tap an entry to edit it.
let logRange = 'day', allRows = [], editing = null;
const shownRows = () => (logRange === 'all' ? allRows : treatments);
const whenLabel = t => {
  const d = new Date(t);
  return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ') + fmtClock(t);
};

/** Reload what the log shows and redraw everything that depends on it. */
async function refreshLog() {
  treatments = await getTreatments(nowMs() - DAY_MS);
  if (logRange === 'all') allRows = await getTreatments(0);
  await loadRecentExtras();
  renderInsulin();
}

function renderRecent() {
  const now = nowMs(), c = curve();
  for (const b of $('logRange').children) b.classList.toggle('active', b.dataset.r === logRange);
  const list = [...shownRows()].reverse();
  $('recentEmpty').hidden = list.length > 0;
  $('recentList').innerHTML = list.map(r => {
    const left = r.kind === 'insulin' ? r.v * iobFraction((now - r.t) / 60e3, c) : 0;
    const when = [r.kind === 'med' ? (r.items ?? []).join(', ') : '', whenLabel(r.t), now - r.t < DAY_MS ? fmtAge(now - r.t) : '', left > 0.005 ? `${fmtU(left)} u still active` : ''].filter(Boolean).join(' · ');
    const [cls, label] = {
      insulin: ['ins', `${fmtDose(r.v)} u rapid-acting`],
      basal: ['bas', `${fmtDose(r.v)} u long-acting`],
      carbs: ['car', `${fmtDose(r.v)} g carbs`],
      med: ['med', `${esc(r.name)} taken`],
    }[r.kind] ?? ['', ''];
    return `<li><button class="row" data-edit="${esc(r.id)}" aria-label="Edit this entry"><b class="${cls}">${label}</b><br>` +
      `<span class="when">${esc(when)}</span></button>` +
      `<button class="del" data-del="${esc(r.id)}" aria-label="Delete this entry" title="Delete">×</button></li>`;
  }).join('');
}

async function deleteEntry(id) {
  if (!confirm('Delete this entry?')) return false;
  await deleteTreatment(id);
  noteDeleted(id);
  syncSoon();
  await refreshLog();
  return true;
}

$('logRange').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  logRange = b.dataset.r;
  if (logRange === 'all') allRows = await getTreatments(0);
  hideEdit();
  renderRecent();
});

function hideEdit() { editing = null; $('editForm').hidden = true; setMsg('editError'); }

$('recentList').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) return void deleteEntry(del.dataset.del);
  const row = e.target.closest('[data-edit]');
  if (!row) return;
  editing = shownRows().find(r => r.id === row.dataset.edit) ?? null;
  if (!editing) return;
  const k = editing.kind;
  $('editTitle').textContent = { insulin: 'Edit rapid-acting entry', basal: 'Edit long-acting entry', carbs: 'Edit carbs entry', med: 'Edit medication entry' }[k];
  $('eAmtLabel').textContent = k === 'carbs' ? 'Carbs (g)' : 'Insulin (units)';
  $('eAmtField').hidden = k === 'med';
  $('eNameField').hidden = k !== 'med';
  $('eItemsField').hidden = k !== 'med';
  $('eItems').value = (editing.items ?? []).join(', ');
  $('eTypeField').hidden = !(k === 'insulin' || k === 'basal');
  $('eType').value = k === 'basal' ? 'long' : 'rapid';
  $('eName').value = editing.name ?? '';
  $('eAmt').value = fmtDose(editing.v);
  $('eTime').value = toLocalInput(editing.t);
  setMsg('editError');
  $('editForm').hidden = false;
  $('editForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('editCancel').addEventListener('click', hideEdit);
$('editDelete').addEventListener('click', async () => { if (editing && await deleteEntry(editing.id)) hideEdit(); });
$('editForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editing) return;
  const med = editing.kind === 'med', carbs = editing.kind === 'carbs';
  const kind = med || carbs ? editing.kind : $('eType').value === 'long' ? 'basal' : 'insulin';
  const v = med ? 1 : parseNum($('eAmt').value), t = new Date($('eTime').value).getTime();
  const name = $('eName').value.trim().slice(0, 40);
  if (med && !name) return setMsg('editError', 'Enter the medication name.');
  const max = carbs ? 500 : kind === 'basal' ? 300 : 100;
  if (!(v > 0) || v > max) return setMsg('editError', carbs ? 'Enter carbs between 0 and 500 g.' : `Enter insulin between 0 and ${max} units.`);
  if (!Number.isFinite(t) || t > nowMs() + 5 * 60e3) return setMsg('editError', 'Choose a time that is not in the future.');
  await putTreatments([{ ...editing, kind, t, v, ...(med ? { name, items: parseItems($('eItems').value) } : {}), u: nowMs() }]);   // same id replaces it; u says when it was last edited
  hideEdit();
  await refreshLog();
  syncSoon();
  toast('Saved.');
});

// Settings fields. Each saves as soon as its value is valid; for the three dose-affecting ones, blank clears it.
const mgOf = v => v * (prefs.useMmol ? MMOL : 1);
const numField = (id, key, { min, max, blank = false, toStore = v => v, toShow = v => String(v) }) => {
  $(id).addEventListener('input', e => {
    const n = parseNum(e.target.value);
    if (n == null && !blank) return;
    const v = n == null ? null : toStore(n);
    if (v != null && !(v >= min && v <= max)) return setMsg('iError', 'One of those values is out of range.');
    setMsg('iError');
    prefs[key] = v;
    touchSetting(key);
    savePrefs(prefs);
    syncSoon();
  });
  return () => { $(id).value = prefs[key] == null ? '' : toShow(prefs[key]); };
};
const showGlucoseish = v => (prefs.useMmol ? (v / MMOL).toFixed(2).replace(/\.?0+$/, '') : String(Math.round(v * 10) / 10));
// ---- optional cloud sync of the log (sync.js). Never blocks logging: a failed sync just shows a message.
let syncState = { busy: false, error: '' };
let syncTimer = null;

// ---- dose settings travel with the log (settings.js decides: newer change wins, values are range-checked)
function touchSetting(key) { prefs.settingsAt = { ...(prefs.settingsAt ?? {}), [key]: nowMs() }; }

const SETTING_LABELS = { icr: 'Carb ratio', isf: 'Correction factor', target: 'Target', dia: 'Insulin duration', peak: 'Insulin peak', carbHours: 'Carb absorption', step: 'Dose step', maxBolus: 'Max bolus', medButtons: 'Medication buttons' };
function settingText(key, v) {
  if (v == null) return 'off';
  if (key === 'isf') return `${showGlucoseish(v)} ${unitsLabel(prefs.useMmol)} per u`;
  if (key === 'target') return `${fmtGlucoseNum(v, prefs.useMmol)} ${unitsLabel(prefs.useMmol)}`;
  if (key === 'icr') return `${v} g per u`;
  if (key === 'dia' || key === 'carbHours') return `${v} h`;
  if (key === 'peak') return `${v} min`;
  if (key === 'medButtons') return v.length ? v.map(m => m.label).join(', ') : 'none';
  return `${v} u`;   // dose step, max bolus
}

/** Apply the settings the drive sent back. Anything that actually changed here is listed in a notice until dismissed. */
function applyMergedSettings(merged) {
  const { prefs: next, changes } = applyRemote(prefs, merged, nowMs());
  Object.assign(prefs, next);
  if (!changes.length) return savePrefs(prefs);
  const lines = changes.map(c => `${SETTING_LABELS[c.key]} ${settingText(c.key, c.to)}${c.from != null && !(Array.isArray(c.from) && !c.from.length) ? ` (was ${settingText(c.key, c.from)})` : ''}`);
  prefs.settingsNotice = [...(prefs.settingsNotice ?? []), ...lines].slice(-8);
  savePrefs(prefs);
  renderInsulinSettings();
  toast('Settings updated from your other device.');
}

async function runSync() {
  if (!prefs.insulinOn || !connectedTo() || syncState.busy) return;
  syncState = { busy: true, error: '' };
  renderSyncLine();
  try {
    const { offer, at } = offerSettings(prefs, DEFAULT_PREFS, nowMs());
    prefs.settingsAt = at;
    savePrefs(prefs);
    const r = await syncNow(offer);
    applyMergedSettings(r.settings);
    treatments = await getTreatments(nowMs() - DAY_MS);
    if (r.added) toast(`Synced: ${r.added} new ${r.added === 1 ? 'entry' : 'entries'}.`);
  } catch (err) {
    syncState.error = needsReconnect(err) ? 'Sign in again to keep syncing.' : "Couldn't reach your drive. Your log is safe on this device.";
  }
  syncState.busy = false;
  renderAll();
  renderSyncLine();
}
/** Sync shortly after a change, so several quick edits make one upload. */
function syncSoon() {
  if (!prefs.insulinOn || !connectedTo()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 3000);
}

function renderSyncLine() {
  const p = connectedTo();
  const avail = configured();
  $('syncMs').hidden = !!p || !avail.includes('microsoft');
  $('syncGoogle').hidden = !!p || !avail.includes('google');
  $('syncNow').hidden = !p;
  $('syncOff').hidden = !p;
  $('syncNow').disabled = syncState.busy;
  const last = loadSyncLast();
  $('syncLine').textContent = p
    ? `Linked to ${PROVIDERS[p].name}.${last ? ` Last synced ${fmtClock(last)}.` : ''} ${syncState.busy ? 'Syncing…' : syncState.error}`
    : avail.length ? 'Not linked.' : 'Cloud sync is not set up in this copy of the app.';
}
const loadSyncLast = () => { try { return JSON.parse(localStorage.getItem('ga.sync'))?.last ?? 0; } catch { return 0; } };
$('syncMs').addEventListener('click', () => connect('microsoft'));
$('syncGoogle').addEventListener('click', () => connect('google'));
$('syncNow').addEventListener('click', runSync);
$('syncOff').addEventListener('click', () => {
  if (!confirm('Disconnect from your drive? The log stays on this device, and the copy in your drive is left as it is.')) return;
  disconnect();
  syncState = { busy: false, error: '' };
  renderSyncLine();
});

const insulinFields = [
  numField('sIcr', 'icr', { min: 1, max: 150, blank: true }),
  numField('sIsf', 'isf', { min: 5, max: 400, blank: true, toStore: mgOf, toShow: showGlucoseish }),
  numField('sTarget', 'target', { min: 70, max: 200, blank: true, toStore: v => Math.round(mgOf(v)), toShow: v => fmtGlucoseNum(v, prefs.useMmol) }),
  numField('sMax', 'maxBolus', { min: 1, max: 50 }),
  numField('sDia', 'dia', { min: 3, max: 8 }),
  numField('sPeak', 'peak', { min: 30, max: 120 }),
  numField('sCarbH', 'carbHours', { min: 1, max: 8 }),
];
$('sStep').addEventListener('change', e => { prefs.step = Number(e.target.value); touchSetting('step'); savePrefs(prefs); syncSoon(); });
const parseItems = text => text.split(',').map(i => i.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
/** "Bedtime meds: Metformin 500 mg, Atorvastatin 20 mg" per line -> [{ label, items }] */
const parseMedButtons = text => text.split('\n').map(line => {
  const i = line.indexOf(':');
  const label = (i < 0 ? line : line.slice(0, i)).trim().slice(0, 30);
  return label ? { label, items: i < 0 ? [] : parseItems(line.slice(i + 1)) } : null;
}).filter(Boolean).slice(0, 6);
const formatMedButtons = list => list.map(m => m.items.length ? `${m.label}: ${m.items.join(', ')}` : m.label).join('\n');
$('sMeds').addEventListener('input', e => { prefs.medButtons = parseMedButtons(e.target.value); touchSetting('medButtons'); savePrefs(prefs); syncSoon(); });
function renderInsulinSettings() {
  for (const f of insulinFields) f();
  $('sMeds').value = formatMedButtons(prefs.medButtons ?? []);
  $('sStep').value = String(prefs.step);
  renderSyncLine();
  $('sIsfLabel').textContent = `Correction (${unitsLabel(prefs.useMmol)} per unit)`;
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('exportBtn').addEventListener('click', async () => {
  const rows = await getTreatments(0);
  if (!rows.length) return toast('Nothing logged to export.', true);
  download('glucoseanywhere-insulin-log.json', 'application/json',
    JSON.stringify({ app: 'GlucoseAnywhere', version: 1, treatments: rows }, null, 1));
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const rows = (data.treatments ?? []).map(cleanTreatment).filter(Boolean);
    if (!rows.length) return toast('No log entries found in that file.', true);
    await putTreatments(rows);   // an id already here is replaced, so importing twice adds nothing
    treatments = await getTreatments(nowMs() - DAY_MS);
    syncSoon();
    toast(`Imported ${rows.length} entries.`);
  } catch { toast("That file isn't an insulin log.", true); }
});

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
  $('sStartBig').checked = !!prefs.startBig;
  $('sLayout').value = prefs.layout;
  $('sStayAwake').checked = !!prefs.stayAwake;
  renderInsulinSettings();
  applyInsulinOptional();
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
  $('dataLine').textContent = `${readings.length} readings from the last 24 hours are shown. Older readings are kept on this device for up to 90 days${prefs.insulinOn ? ', and the insulin log until you delete it' : ''}.`;
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
  creds = null; client = null; readings = []; treatments = [];
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
  if (tab !== 'home') { if (key === 'escape') closePage(); return; }
  if (key === 'escape') {
    if (bigOpen && !fsElement()) exitBig();      // the first Esc leaves fullscreen (the browser handles it)
  } else if (key === 's' && !bigOpen) {
    openSettings();
  } else if (key === 'i' && !bigOpen) {
    openInsulin();
  } else if (key === 'l' && !bigOpen) {
    openLog();
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
const UPDATE_FILES = ['./', 'app.js', 'store.js', 'dexcom.js', 'chart.js', 'insulin.js', 'settings.js', 'sync.js', 'sync-config.js', 'format.js', 'theme.js', 'app.css'];
const UPDATE_CHECK_MS = 3600e3, UPDATE_IDLE_MS = 60e3;
let versionTag = null, lastTouch = 0, updateTimer = null;   // 0: nobody has touched it yet

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
  applyInsulinOptional();
  creds = loadCreds();
  // Coming back from Google or Microsoft's sign-in page: store the link first, then open as usual.
  finishSignIn().then(r => {
    if (creds) enterApp(); else showAuth();
    if (r?.error) toast(r.error, true);
    else if (r?.provider) { toast(`Linked to ${PROVIDERS[r.provider].name}.`); if (creds) { openInsulin(); } }
  });
}
boot();
