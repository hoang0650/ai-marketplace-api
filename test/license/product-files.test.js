const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isDownloadCategory, safeFilename } = require('../../src/routes/product-files');

describe('product files (skill packs / datasets)', () => {
  test('only skill packs and datasets carry downloadable files', () => {
    assert.equal(isDownloadCategory('skill-pack'), true);
    assert.equal(isDownloadCategory('dataset'), true);
    assert.equal(isDownloadCategory('ai-film-series'), false);
    assert.equal(isDownloadCategory(''), false);
  });

  test('download filenames are sanitized', () => {
    assert.equal(safeFilename('../../etc/passwd'), 'passwd');
    assert.equal(safeFilename('bộ dữ liệu.jsonl'), 'b_d_li_u.jsonl');
    assert.equal(safeFilename('...'), 'file.bin');
    assert.equal(safeFilename('train.jsonl'), 'train.jsonl');
  });
});

describe('product file access', () => {
  const { licenseBelongsTo, resolveAccess } = require('../../src/routes/product-files');
  const product = { _id: '507f1f77bcf86cd799439011', creator: '507f1f77bcf86cd7994390aa' };

  test('a license key only counts for the account it was issued to', () => {
    assert.equal(licenseBelongsTo({ buyer: 'u1' }, 'u1'), true);
    assert.equal(licenseBelongsTo({ buyer: { _id: 'u1' } }, 'u1'), true);
    assert.equal(licenseBelongsTo({ buyer: 'u1' }, 'u2'), false);
    assert.equal(licenseBelongsTo(null, 'u1'), false);
  });

  test('anonymous callers have no access; admin and the listing seller are labelled', async () => {
    assert.equal((await resolveAccess(null, product, '')).via, null);
    assert.equal((await resolveAccess({ _id: 'x', role: 'admin' }, product, '')).via, 'admin');
    assert.equal((await resolveAccess({ _id: product.creator, role: 'seller' }, product, '')).via, 'seller');
  });
});
