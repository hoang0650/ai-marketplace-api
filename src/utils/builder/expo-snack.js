/**
 * Publish app templates / Builder app projects as Expo Snacks so a phone running Expo Go
 * can open the real React Native code natively (exp://u.expo.dev/... deep link + QR).
 *
 * Anonymous Snack saves need no credential. Expo Go from the stores runs exactly one SDK,
 * so every Snack targets EXPO_SNACK_SDK (not the template's own `expo` version); the
 * template's SDK is reported so the UI can say when it was retargeted.
 */
const crypto = require('crypto');
const ExpoSnack = require('../../models/ExpoSnack');

/** Snack's runtime project on EAS Update (what snack.expo.dev QR codes point at). */
const SNACK_RUNTIME_PROJECT = '933fd9c0-1666-11e7-afca-d980795c5824';
const SNACK_API = 'https://exp.host';
const ERROR_RETRY_MS = 10 * 60 * 1000;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** Provided by the Snack runtime itself; never listed as Snack dependencies. */
const RUNTIME_DEPS = new Set(['expo', 'react', 'react-native', 'react-dom', 'react-native-web', 'typescript', '@babel/core']);
const CODE_EXT = /\.(js|jsx|ts|tsx|json|md|txt|css)$/i;

function settings() {
  const v = String(process.env.EXPO_SNACK_SDK || '54.0.0').trim();
  return {
    enabled: !['0', 'false', 'off'].includes(String(process.env.EXPO_SNACK_ENABLED || '1').trim().toLowerCase()),
    sdkVersion: /^\d{2,3}\.0\.0$/.test(v) ? v : '54.0.0',
  };
}

function readPackageJson(files) {
  const f = (files || []).find((x) => x.path === 'package.json');
  if (!f) return null;
  try {
    return JSON.parse(f.content || '');
  } catch {
    return null;
  }
}

/** Major SDK the template declares in package.json ("~53.0.0" -> "53.0.0"), or ''. */
function templateSdk(files) {
  const v = String(readPackageJson(files)?.dependencies?.expo || '');
  const m = v.match(/(\d{2,3})\.\d+/);
  return m ? `${m[1]}.0.0` : '';
}

function snackUrl(sdkVersion, id) {
  return `exp://u.expo.dev/${SNACK_RUNTIME_PROJECT}?runtime-version=${encodeURIComponent(`exposdk:${sdkVersion}`)}&channel-name=production&snack=${encodeURIComponent(id)}`;
}

function snackWebUrl(id) {
  return `https://snack.expo.dev/${encodeURIComponent(id)}`;
}

/** Turns stored files into a Snack save payload. Throws {code} for unusable inputs. */
function buildPayload({ name, files }, sdkVersion) {
  const list = (files || []).filter((f) => f && typeof f.path === 'string' && !f.path.startsWith('node_modules/'));
  if (!list.length) throw Object.assign(new Error('No files'), { code: 'SNACK_NO_FILES' });
  const code = {};
  let total = 0;
  for (const f of list) {
    if (f.path === 'package.json' || !CODE_EXT.test(f.path)) continue;
    const contents = String(f.content || '');
    total += Buffer.byteLength(contents);
    code[f.path] = { type: 'CODE', contents };
  }
  const entries = Object.keys(code);
  if (!entries.some((p) => /^App\.(js|jsx|ts|tsx)$/.test(p))) {
    throw Object.assign(new Error('Snack needs App.js or App.tsx at the root'), { code: 'SNACK_NO_ENTRY' });
  }
  if (entries.length > MAX_FILES || total > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error('Too large for a Snack'), { code: 'SNACK_TOO_LARGE' });
  }
  const deps = {};
  for (const [dep, version] of Object.entries(readPackageJson(list)?.dependencies || {})) {
    if (RUNTIME_DEPS.has(dep) || typeof version !== 'string') continue;
    // Snack resolves expo-* modules to the version bundled with the target SDK.
    deps[dep] = { version: dep.startsWith('expo-') || dep.startsWith('@expo/') ? '*' : version };
  }
  return {
    manifest: {
      sdkVersion,
      name: String(name || 'AI Markets app').slice(0, 80),
      description: 'Published from AI Markets',
      dependencies: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.version])),
    },
    code,
    dependencies: deps,
    isDraft: false,
  };
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function saveSnack(payload, fetchImpl = globalThis.fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetchImpl(`${SNACK_API}/--/api/v2/snack/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.id) {
      throw Object.assign(new Error(data?.errors?.[0]?.message || `Snack save failed (HTTP ${r.status})`), { code: 'SNACK_SAVE_FAILED' });
    }
    return String(data.id);
  } catch (err) {
    if (err.code) throw err;
    throw Object.assign(new Error(err.name === 'AbortError' ? 'Snack save timed out' : 'Snack service unreachable'), { code: 'SNACK_SAVE_FAILED' });
  } finally {
    clearTimeout(timer);
  }
}

function view(doc, extra) {
  return {
    enabled: true,
    available: !!doc.url,
    url: doc.url || '',
    snackId: doc.snackId || '',
    webUrl: doc.snackId ? snackWebUrl(doc.snackId) : '',
    sdkVersion: doc.sdkVersion || '',
    savedAt: doc.savedAt || null,
    error: doc.url ? '' : doc.error || '',
    ...extra,
  };
}

const bundledCache = new Map();

/** SDK-pinned versions of Expo modules (expo-status-bar etc.), so Snack doesn't guess. */
async function bundledVersions(sdkVersion, fetchImpl = globalThis.fetch) {
  const hit = bundledCache.get(sdkVersion);
  if (hit) return hit;
  try {
    const r = await fetchImpl(`https://api.expo.dev/v2/sdks/${sdkVersion}/native-modules`);
    const list = (await r.json())?.data || [];
    const map = Object.fromEntries(list.map((m) => [m.npmPackage, m.versionRange]));
    if (list.length) bundledCache.set(sdkVersion, map);
    return map;
  } catch {
    return {};
  }
}

function pinDependencies(payload, bundled) {
  for (const [dep, d] of Object.entries(payload.dependencies)) {
    if (d.version === '*' && bundled[dep]) d.version = bundled[dep];
    payload.manifest.dependencies[dep] = d.version;
  }
  return payload;
}

const inflight = new Map();

/**
 * Returns the cached Snack for `key`, publishing a new one only when the payload hash
 * changed. A failed publish is remembered and retried after ERROR_RETRY_MS.
 */
async function ensureSnack(key, source, { fetchImpl, bundled } = {}) {
  const { enabled, sdkVersion } = settings();
  const tSdk = templateSdk(source.files);
  const extra = { templateSdk: tSdk, retargeted: !!tSdk && tSdk !== sdkVersion };
  if (!enabled) return { enabled: false, available: false, url: '', error: 'SNACK_DISABLED', sdkVersion, ...extra };
  let payload;
  try {
    payload = buildPayload(source, sdkVersion);
  } catch (err) {
    return { enabled: true, available: false, url: '', error: err.code || 'SNACK_INVALID', sdkVersion, ...extra };
  }
  const hash = hashPayload(payload);
  const cached = await ExpoSnack.findOne({ key }).lean();
  if (cached?.url && cached.hash === hash) return view(cached, extra);
  if (cached?.errorHash === hash && cached.errorAt && Date.now() - new Date(cached.errorAt).getTime() < ERROR_RETRY_MS) {
    return { ...view({ ...cached, url: '' }, extra), sdkVersion, error: cached.error || 'SNACK_SAVE_FAILED' };
  }
  const flightKey = `${key}:${hash}`;
  if (!inflight.has(flightKey)) {
    inflight.set(
      flightKey,
      (async () => {
        try {
          pinDependencies(payload, bundled || (await bundledVersions(sdkVersion)));
          const id = await saveSnack(payload, fetchImpl);
          const set = { hash, sdkVersion, snackId: id, url: snackUrl(sdkVersion, id), savedAt: new Date(), error: '', errorHash: '', errorAt: null };
          return await ExpoSnack.findOneAndUpdate({ key }, { $set: set }, { upsert: true, new: true }).lean();
        } catch (err) {
          const set = { error: err.code || 'SNACK_SAVE_FAILED', errorHash: hash, errorAt: new Date() };
          // Keep serving an older working Snack while the new version can't publish.
          const doc = await ExpoSnack.findOneAndUpdate({ key }, { $set: set }, { upsert: true, new: true }).lean();
          return { ...doc, url: doc.hash === hash ? doc.url : '', staleUrl: doc.url };
        } finally {
          inflight.delete(flightKey);
        }
      })()
    );
  }
  const doc = await inflight.get(flightKey);
  if (!doc.url && doc.staleUrl) return { ...view({ ...doc, url: doc.staleUrl }, extra), stale: true, error: doc.error };
  return view(doc, extra);
}

module.exports = { ensureSnack, pinDependencies, buildPayload, templateSdk, snackUrl, snackWebUrl, settings, SNACK_RUNTIME_PROJECT };
