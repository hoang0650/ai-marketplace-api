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
