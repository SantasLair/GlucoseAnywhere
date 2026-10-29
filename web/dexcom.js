// Browser client for the Dexcom Share service (the backend the Dexcom Follow app uses).
// Dexcom answers CORS preflights with access-control-allow-origin: *, so no proxy is needed.
const APP_ID = 'd89443d2-327c-4a6f-89e5-496bbb0317db';
const APP_ID_JAPAN = 'd8665ade-9673-4e27-9ff6-92db4ce13d13';
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BASE_URLS = {
  US: 'https://share2.dexcom.com/ShareWebServices/Services/',
  OutsideUS: 'https://shareous1.dexcom.com/ShareWebServices/Services/',
  Japan: 'https://share.dexcom.jp/ShareWebServices/Services/',
};

const TREND_NAMES = [
  'None', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat',
  'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NotComputable', 'RateOutOfRange',
];

export class DexcomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
  /** True when retrying with the same credentials is pointless (and could lock the account). */
  get isAuthError() {
    return this.code.startsWith('SSO_') || this.code.startsWith('Account') || this.code === 'InvalidPassword';
  }
}

export class DexcomClient {
  /**
   * @param {{username: string, password: string, region: string}} creds
   * @param {{accountId?: string, sessionId?: string}} [session] cached ids from an earlier sign-in
   */
  constructor(creds, session = {}) {
    this.username = creds.username.trim();
    this.password = creds.password;
    this.base = BASE_URLS[creds.region] ?? BASE_URLS.US;
    this.appId = creds.region === 'Japan' ? APP_ID_JAPAN : APP_ID;
    this.accountId = session.accountId ?? null;
    this.sessionId = session.sessionId ?? null;
  }

  /** The ids worth caching so the next visit can skip the sign-in. */
  get session() { return { accountId: this.accountId, sessionId: this.sessionId }; }

  /** Readings from the last `minutes`, oldest first, as { t (ms), v (mg/dL), trend }. */
  async readings(minutes, maxCount) {
    this.sessionId ??= await this.#login();
    try {
      return await this.#read(minutes, maxCount);
    } catch (err) {
      if (!(err instanceof DexcomError) || !['SessionIdNotFound', 'SessionNotValid'].includes(err.code)) throw err;
      this.sessionId = await this.#login();
      return await this.#read(minutes, maxCount);
    }
  }

  async #login() {
    if (!this.accountId) {
      const id = GUID.test(this.username)
        ? this.username
        : await this.#post('General/AuthenticatePublisherAccount',
            { accountName: this.username, password: this.password, applicationId: this.appId });
      if (!id || id === EMPTY_GUID) throw new DexcomError('AccountNotFound', 'Dexcom account not found.');
      this.accountId = id;
    }
    const sid = await this.#post('General/LoginPublisherAccountById',
      { accountId: this.accountId, password: this.password, applicationId: this.appId });
    if (!sid || sid === EMPTY_GUID) throw new DexcomError('InvalidPassword', 'Dexcom rejected the password.');
    return sid;
  }

  async #read(minutes, maxCount) {
    const rows = await this.#post(
      `Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(this.sessionId)}&minutes=${minutes}&maxCount=${maxCount}`,
      {}) ?? [];
    const out = [];
    for (const row of rows) {
      const m = /Date\((\d+)/.exec(row.WT ?? row.ST ?? '');
      if (!m || typeof row.Value !== 'number') continue;
      out.push({ t: Number(m[1]), v: row.Value, trend: parseTrend(row.Trend) });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async #post(path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res, text;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
      });
      text = await res.text();
    } catch {
      throw new DexcomError('Network', navigator.onLine === false
        ? "You're offline."
        : "Can't reach Dexcom right now.");
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      throw new DexcomError(data?.Code ?? `HTTP${res.status}`, data?.Message ?? `Dexcom returned HTTP ${res.status}.`);
    }
    return data;
  }
}

function parseTrend(t) {
  if (typeof t === 'string') return t || 'None';
  if (Number.isInteger(t) && t >= 0 && t < TREND_NAMES.length) return TREND_NAMES[t];
  return 'None';
}
