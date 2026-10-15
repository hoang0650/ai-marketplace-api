const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeUrl,
  sanitizeMediaUrl,
  sanitizeProfile,
  sanitizePreferences,
  accountActivity,
  MAX_SOCIALS,
} = require('../../src/utils/profile-settings');

test('sanitizeUrl accepts http(s), clears empty, rejects data:/javascript:', () => {
  assert.equal(sanitizeUrl(''), '');
  assert.equal(sanitizeUrl('  https://aimarkets.vn/a  '), 'https://aimarkets.vn/a');
  assert.throws(() => sanitizeUrl('javascript:alert(1)'), /http\(s\) URL/);
  assert.throws(() => sanitizeUrl('not a url'), /http\(s\) URL/);
  assert.throws(() => sanitizeMediaUrl('data:image/png;base64,AAAA', 'avatarUrl'), /avatarUrl/);
  assert.throws(() => sanitizeUrl(`https://x.vn/${'a'.repeat(400)}`), /too long/);
});

test('sanitizeProfile merges partial patches and validates enums', () => {
  const current = { introLine: 'buyer', region: 'HCM', website: '', notifyLang: 'vi', socials: [] };
  const next = sanitizeProfile({ region: ' Hà Nội ', notifyLang: 'en' }, current);
  assert.deepEqual(next, { introLine: 'buyer', region: 'Hà Nội', website: '', notifyLang: 'en', socials: [] });
  assert.throws(() => sanitizeProfile({ introLine: 'hacker' }, current), /introLine/);
  assert.throws(() => sanitizeProfile({ notifyLang: 'fr' }, current), /notifyLang/);
});

test('sanitizeProfile drops empty social rows and caps the list', () => {
  const next = sanitizeProfile({
    socials: [
      { label: 'GitHub', url: 'https://github.com/x' },
      { label: 'empty', url: '' },
      { label: '', url: 'https://x.com/y' },
    ],
  });
  assert.deepEqual(next.socials, [
    { label: 'GitHub', url: 'https://github.com/x' },
    { label: 'Link', url: 'https://x.com/y' },
  ]);
  const tooMany = Array.from({ length: MAX_SOCIALS + 1 }, (_, i) => ({ label: 'l', url: `https://a.vn/${i}` }));
  assert.throws(() => sanitizeProfile({ socials: tooMany }), /At most/);
});

test('sanitizePreferences coerces booleans and keeps untouched keys', () => {
  assert.deepEqual(sanitizePreferences({ personalizeAds: 1 }, { personalizeContent: true }), {
    personalizeContent: true,
    personalizeAds: true,
    emailLoginAlerts: true,
  });
  assert.equal(sanitizePreferences({ emailLoginAlerts: 0 }, {}).emailLoginAlerts, false);
});

test('accountActivity lists known events newest first', () => {
  const items = accountActivity(
    {
      createdAt: '2026-01-01T00:00:00Z',
      passwordChangedAt: '2026-03-01T00:00:00Z',
      kyc: { status: 'verified', submittedAt: '2026-02-01T00:00:00Z', reviewedAt: '2026-02-02T00:00:00Z' },
    },
    { lastLogin: '2026-04-01T00:00:00Z', lastLoginIp: '1.2.3.4' },
  );
  assert.deepEqual(
    items.map((i) => i.type),
    ['last_login', 'password_changed', 'kyc_verified', 'kyc_submitted', 'account_created'],
  );
  assert.equal(items[0].ip, '1.2.3.4');
});
