/**
 * GPU / game stream client split.
 *  - pc:     web / desktop browser — keyboard + mouse (+ gamepad), high quality.
 *  - mobile: Android / iOS app — touch + virtual gamepad, landscape, lower bitrate.
 * Sellers declare which devices a node serves; the buyer's client picks the profile.
 */
const DEVICES = ['pc', 'mobile'];
const CLIENTS = ['pc', 'android', 'ios'];

const CLIENT_DEVICE = {
  pc: 'pc',
  web: 'pc',
  desktop: 'pc',
  windows: 'pc',
  mac: 'pc',
  linux: 'pc',
  mobile: 'mobile',
  android: 'mobile',
  ios: 'mobile',
};

const PROFILES = {
  pc: {
    device: 'pc',
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 60,
    bitrateKbps: 15000,
    inputs: ['keyboard', 'mouse', 'gamepad'],
    orientation: 'any',
  },
  mobile: {
    device: 'mobile',
    maxWidth: 1280,
    maxHeight: 720,
    fps: 60,
    bitrateKbps: 6000,
    inputs: ['touch', 'virtual-gamepad', 'gamepad'],
    orientation: 'landscape',
  },
};

function clientFromUserAgent(ua) {
  const s = String(ua || '');
  if (/android/i.test(s)) return 'android';
  if (/iphone|ipad|ipod/i.test(s)) return 'ios';
  return 'pc';
}

/** `{ client: 'pc'|'android'|'ios', device: 'pc'|'mobile' }` from body/query, falling back to User-Agent. */
function resolveClient(raw, userAgent) {
  const key = String(raw || '').trim().toLowerCase();
  if (CLIENTS.includes(key)) return { client: key, device: CLIENT_DEVICE[key] };
  const uaClient = clientFromUserAgent(userAgent);
  const device = CLIENT_DEVICE[key] || CLIENT_DEVICE[uaClient];
  if (device === 'mobile') return { client: uaClient === 'ios' ? 'ios' : 'android', device };
  return { client: 'pc', device: 'pc' };
}

function normalizeDevices(list, fallback = DEVICES) {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : [];
  const out = DEVICES.filter((d) => raw.some((x) => String(x || '').trim().toLowerCase() === d));
  return out.length ? out : [...fallback];
}

function nodeDevices(node) {
  return normalizeDevices(node?.devices);
}

function productDevices(product) {
  return normalizeDevices(product?.streaming?.devices);
}

function streamProfile(device) {
  const p = PROFILES[device] || PROFILES.pc;
  return { ...p, inputs: [...p.inputs] };
}

function assertDeviceSupported(product, device) {
  const devices = productDevices(product);
  if (devices.includes(device)) return devices;
  const err = new Error(device === 'mobile' ? 'This listing only streams to PC (web/desktop)' : 'This listing only streams to the mobile app');
  err.status = 409;
  err.code = 'CLIENT_NOT_SUPPORTED';
  err.body = { device, supportedDevices: devices };
  throw err;
}

/** Mongo filter: nodes that serve `device` (nodes without a device list serve both). */
function deviceNodeFilter(device) {
  return { $or: [{ devices: device }, { devices: { $exists: false } }, { devices: { $size: 0 } }] };
}

module.exports = {
  DEVICES,
  CLIENTS,
  PROFILES,
  resolveClient,
  normalizeDevices,
  nodeDevices,
  productDevices,
  streamProfile,
  assertDeviceSupported,
  deviceNodeFilter,
};
