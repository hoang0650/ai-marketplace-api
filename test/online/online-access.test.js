const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const LicenseKey = require('../../src/models/LicenseKey');
const online = require('../../src/utils/online-access');
const { findActiveLicense } = require('../../src/utils/content-drm');

const PRODUCT = { _id: '507f1f77bcf86cd799439011', creator: '507f1f77bcf86cd7994390aa', category: 'dataset', slug: 'ds' };
const BUYER = { _id: '507f1f77bcf86cd7994390b1', role: 'buyer' };
const OTHER = '507f1f77bcf86cd7994390c2';
const future = () => new Date(Date.now() + 3600_000);
const past = () => new Date(Date.now() - 1000);
const lic = (over = {}) => ({ _id: 'L1', licenseKey: 'AIM-AAAA', buyer: BUYER._id, product: PRODUCT._id, status: 'active', expiresAt: future(), ...over });

const orig = { findOne: LicenseKey.findOne, find: LicenseKey.find };
function stubKeys(docs) {
  const q = (rows) => ({ sort: () => ({ limit: async () => rows }), lean: async () => rows[0] || null, then: (r, j) => Promise.resolve(rows[0] || null).then(r, j) });
  LicenseKey.findOne = (filter) => q(docs.filter((d) => d.licenseKey === filter.licenseKey));
  LicenseKey.find = (filter) => q(docs.filter((d) => String(d.buyer) === String(filter.buyer)));
}
afterEach(() => Object.assign(LicenseKey, orig));

describe('online-only access', () => {
  test('datasets, skills, films and stories are online-only', () => {
    for (const c of ['dataset', 'skill-pack', 'ai-film-series', 'story-book']) assert.equal(online.isOnlineOnlyCategory(c), true);
    assert.equal(online.isOnlineOnlyCategory('voice-preset'), false);
  });

  test('admin gets labelled moderation access, the seller owner access, anonymous nothing', async () => {
    assert.equal((await online.resolveOnlineAccess({ user: { _id: 'a', role: 'admin' }, product: PRODUCT })).via, 'moderation');
    assert.equal((await online.resolveOnlineAccess({ user: { _id: PRODUCT.creator }, product: PRODUCT })).via, 'owner');
    assert.equal((await online.resolveOnlineAccess({ user: null, product: PRODUCT })).reason, 'AUTH_REQUIRED');
  });

  test('buyers need their own, unexpired key', async () => {
    stubKeys([lic(), lic({ _id: 'L2', licenseKey: 'AIM-OTHER', buyer: OTHER }), lic({ _id: 'L3', licenseKey: 'AIM-OLD', expiresAt: past() })]);
    const r1 = await online.resolveOnlineAccess({ user: BUYER, product: PRODUCT, licenseKey: '', requireKey: true });
    assert.equal(r1.reason, 'LICENSE_KEY_REQUIRED');
    const r2 = await online.resolveOnlineAccess({ user: BUYER, product: PRODUCT, licenseKey: 'aim-aaaa', requireKey: true });
    assert.equal(r2.via, 'license');
    const r3 = await online.resolveOnlineAccess({ user: BUYER, product: PRODUCT, licenseKey: 'AIM-OTHER', requireKey: true });
    assert.equal(r3.reason, 'LICENSE_NOT_YOURS');
    assert.equal(online.denyStatus(r3.reason), 403);
    const r4 = await online.resolveOnlineAccess({ user: BUYER, product: PRODUCT, licenseKey: 'AIM-OLD', requireKey: true });
    assert.equal(r4.reason, 'LICENSE_EXPIRED');
    assert.equal(online.denyStatus(r4.reason), 402);
  });

  test('findActiveLicense ignores keys issued to another account', async () => {
    stubKeys([lic({ licenseKey: 'AIM-OTHER', buyer: OTHER })]);
    assert.equal(await findActiveLicense({ buyerId: BUYER._id, licenseKey: 'AIM-OTHER', productId: PRODUCT._id }), null);
    assert.equal(await findActiveLicense({ licenseKey: 'AIM-OTHER', productId: PRODUCT._id }), null);
    stubKeys([lic()]);
    assert.ok(await findActiveLicense({ buyerId: BUYER._id, licenseKey: 'AIM-AAAA', productId: PRODUCT._id }));
  });

  test('trace ids verify against their license only; row watermarks are per license', () => {
    const t = online.traceId('L1');
    assert.match(t, /^t_[0-9a-z]+_[\w-]{12}$/);
    assert.equal(online.verifyTrace(t, 'L1'), true);
    assert.equal(online.verifyTrace(t, 'L2'), false);
    assert.equal(online.rowWatermark('L1', 'p', 'train', 5), online.rowWatermark('L1', 'p', 'train', 5));
    assert.notEqual(online.rowWatermark('L1', 'p', 'train', 5), online.rowWatermark('L2', 'p', 'train', 5));
  });

  test('ONLINE_ONLY body points buyers at the online endpoints', () => {
    const b = online.onlineOnlyBody({ slug: 'x', category: 'skill-pack' });
    assert.equal(b.code, 'ONLINE_ONLY');
    assert.equal(b.online.run, '/v1/skills/x/run');
    assert.equal(online.onlineOnlyBody({ slug: 'd', category: 'dataset' }).online.rows.startsWith('/v1/datasets/d/rows'), true);
  });

  test('quota defaults keep a dataset from being pulled in seconds', () => {
    const q = online.quotaDefaults().dataset;
    assert.ok(q.maxLimit <= 500 && q.rowsPerMinute <= 3000 && q.rowsPerDay <= 30000);
  });
});

describe('quota windows', () => {
  const Usage = require('../../src/models/OnlineAccessUsage');
  const o = { find: Usage.find, updateOne: Usage.updateOne };
  afterEach(() => Object.assign(Usage, o));

  test('rows are capped by what is left this minute and requests over the limit get 429', async () => {
    const store = new Map();
    Usage.find = (f) => ({ lean: async () => f.key.$in.map((k) => store.get(k)).filter(Boolean) });
    Usage.updateOne = async (f, u) => {
      const row = store.get(f.key) || { key: f.key, window: u.$setOnInsert.window, requests: 0, units: 0 };
      row.requests += u.$inc.requests;
      row.units += u.$inc.units;
      store.set(f.key, row);
    };
    const limits = { requestsPerMinute: 3, unitsPerMinute: 250, unitsPerDay: 1000 };
    const a = await online.takeQuota({ scope: 's', kind: 'dataset', limits, wantUnits: 200 });
    assert.equal(a.allowedUnits, 200);
    await a.commit(200);
    const b = await online.takeQuota({ scope: 's', kind: 'dataset', limits, wantUnits: 200 });
    assert.equal(b.allowedUnits, 50);
    await b.commit(50);
    await assert.rejects(online.takeQuota({ scope: 's', kind: 'dataset', limits, wantUnits: 1 }), (e) => e.status === 429 && e.code === 'QUOTA_EXCEEDED');
  });

  test('films and stories report LICENSE_EXPIRED for a lapsed own license', async () => {
    stubKeys([lic({ expiresAt: past() }), lic({ _id: 'L2', licenseKey: 'AIM-OTHER', buyer: OTHER, expiresAt: past() })]);
    assert.equal(await online.missingLicenseReason({ userId: BUYER._id, productId: PRODUCT._id }), 'LICENSE_EXPIRED');
    assert.equal(await online.missingLicenseReason({ userId: BUYER._id, productId: PRODUCT._id, licenseKey: 'AIM-OTHER' }), 'LICENSE_REQUIRED');
    assert.equal(await online.missingLicenseReason({ userId: OTHER.replace('c2', 'd3'), productId: PRODUCT._id }), 'LICENSE_REQUIRED');
    stubKeys([lic({ status: 'revoked', expiresAt: past() })]);
    assert.equal(await online.missingLicenseReason({ userId: BUYER._id, productId: PRODUCT._id }), 'LICENSE_REQUIRED');
  });
});
