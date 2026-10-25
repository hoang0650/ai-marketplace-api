const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/utils/online-terms');
const { mapProduct } = require('../../src/utils/mappers');

const seller = { _id: 'u1', role: 'seller' };
const admin = { _id: 'a1', role: 'admin' };

test('terms text covers every required clause in vi, en and zh', () => {
  const { vi, en, zh } = T.ONLINE_TERMS;
  for (const s of [/không chuyển nhượng/, /không cấp phép lại/, /thời hạn giấy phép/, /API/, /phân phối lại/, /cào dữ liệu/, /watermark/, /hết hạn/, /máy chủ/, /bị xóa/]) assert.match(vi, s);
  for (const s of [/non-transferable/, /non-sublicensable/, /license period/, /online player\/reader/, /redistribution/, /scraping/, /reconstruction/, /watermark/, /expires/, /deleted right after the run/]) assert.match(en, s);
  for (const s of [/不可转让/, /不可再许可/, /许可期/, /再分发/, /抓取/, /水印/, /到期/, /删除/]) assert.match(zh, s);
  assert.ok(T.ONLINE_TERMS_SUMMARY.length <= 2000);
  assert.ok(T.ONLINE_LICENSE.length <= 500);
});

test('online categories get the AIM-OL default and record seller acceptance', () => {
  for (const category of ['dataset', 'skill-pack', 'ai-film-series', 'story-book']) {
    const p = { category, license: '', termsSummary: '' };
    assert.deepEqual(T.applyOnlineTerms(p, {}, seller, { now: new Date(0) }), {});
    assert.equal(p.license, T.ONLINE_LICENSE);
    assert.equal(p.termsSummary, T.ONLINE_TERMS_SUMMARY);
    assert.equal(p.onlineTerms.version, T.ONLINE_TERMS_VERSION);
    assert.equal(p.onlineTerms.acceptedBy, 'u1');
    assert.equal(p.onlineTerms.explicit, false);
  }
});

test('sellers cannot replace the license; their notes are appended after the AIM-OL summary', () => {
  const p = { category: 'dataset', license: 'CC0 – do anything', termsSummary: '' };
  T.applyOnlineTerms(p, { termsSummary: 'Ghi chú của người bán', acceptOnlineTerms: true }, seller);
  assert.equal(p.license, T.ONLINE_LICENSE);
  assert.ok(p.termsSummary.startsWith(T.ONLINE_TERMS.vi));
  assert.ok(p.termsSummary.endsWith('Ghi chú của người bán'));
  assert.equal(p.onlineTerms.explicit, true);
});

test('explicitly declining the terms blocks the listing', () => {
  const p = { category: 'story-book', license: '', termsSummary: '' };
  const r = T.applyOnlineTerms(p, { acceptOnlineTerms: false }, seller);
  assert.equal(r.error.code, 'ONLINE_TERMS_REQUIRED');
  assert.equal(p.onlineTerms, undefined);
});

test('other categories are untouched', () => {
  const p = { category: 'ai-model', license: 'Apache-2.0', termsSummary: 'x' };
  T.applyOnlineTerms(p, {}, seller);
  assert.deepEqual(p, { category: 'ai-model', license: 'Apache-2.0', termsSummary: 'x' });
});

test('admin may keep an upstream MIT notice; it states the derivative-work sublicense', () => {
  const notice = T.upstreamMitNotice({ holder: 'Thang Le Quoc', year: 2021, file: 'LICENSE-MIT-thanglequoc.txt' });
  const p = { category: 'dataset', license: 'AIM-OL 1.0 + MIT notice', termsSummary: '' };
  T.applyOnlineTerms(p, { termsSummary: `${T.ONLINE_TERMS_SUMMARY}\n\n${notice}` }, admin);
  assert.equal(p.license, 'AIM-OL 1.0 + MIT notice');
  assert.match(p.termsSummary, /LICENSE-MIT-thanglequoc\.txt/);
  assert.match(p.termsSummary, /derivative work sublicensed under MIT/);
  assert.equal((p.termsSummary.match(/AIM-OL 1\.0[)）]/g) || []).length, 3, 'summary not duplicated');
  assert.ok(p.termsSummary.length <= 2000);
});

test('mapProduct exposes the accepted terms version', () => {
  const m = mapProduct({ _id: 'p1', slug: 's', name: 'n', category: 'dataset', onlineTerms: { version: 'AIM-OL-1.0', acceptedAt: new Date(0) } });
  assert.equal(m.onlineTerms.version, 'AIM-OL-1.0');
  assert.match(m.onlineTerms.url, /terms-of-service#online-license$/);
  assert.equal(mapProduct({ _id: 'p2', slug: 's', name: 'n', category: 'ai-model' }).onlineTerms, null);
});
