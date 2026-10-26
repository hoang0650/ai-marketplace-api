const test = require('node:test');
const assert = require('node:assert');
const {
  adminListParams,
  pageResult,
  userStatusFilter,
  productStatusFilter,
  escapeRegex,
} = require('../../src/utils/admin-list');

test('page size is 20 by default and only 20/50/100 are accepted', () => {
  assert.strictEqual(adminListParams({}).limit, 20);
  assert.strictEqual(adminListParams({ limit: '50' }).limit, 50);
  assert.strictEqual(adminListParams({ limit: '100' }).limit, 100);
  assert.strictEqual(adminListParams({ limit: '5000' }).limit, 20);
  assert.strictEqual(adminListParams({ page: '-3' }).page, 1);
  assert.strictEqual(adminListParams({ page: '4' }).page, 4);
});

test('search is literal, case-insensitive and capped at 100 chars', () => {
  const { rx, q } = adminListParams({ q: '  a.b(c)*  ' });
  assert.strictEqual(q, 'a.b(c)*');
  assert.ok(rx.test('xxA.B(C)*yy'));
  assert.ok(!rx.test('aXb(c)'));
  assert.strictEqual(adminListParams({ q: 'x'.repeat(500) }).q.length, 100);
  assert.strictEqual(adminListParams({ q: '' }).rx, null);
  assert.strictEqual(escapeRegex('$^'), '\\$\\^');
});

test('pageResult reports total pages (at least 1)', () => {
  assert.deepStrictEqual(pageResult([], 0, 1, 20), { items: [], total: 0, page: 1, limit: 20, pages: 1 });
  assert.strictEqual(pageResult([], 109, 1, 20).pages, 6);
});

test('status filters treat missing fields as active / published', () => {
  assert.deepStrictEqual(userStatusFilter('active'), { accountStatus: { $in: ['active', null] } });
  assert.deepStrictEqual(userStatusFilter('blocked'), { accountStatus: 'blocked' });
  assert.deepStrictEqual(productStatusFilter('published'), {
    published: { $ne: false },
    moderationStatus: { $in: ['active', null] },
  });
  assert.deepStrictEqual(productStatusFilter('unpublished'), { published: false });
  assert.deepStrictEqual(productStatusFilter('pending_review'), { moderationStatus: 'pending_review' });
});
