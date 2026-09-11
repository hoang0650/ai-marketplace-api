const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  packAimc,
  parseAimcHeader,
  decryptBuffer,
  episodeDek,
  issuePlayToken,
  takePlayToken,
  playTokens,
  resolveEpisodePages,
} = require('../../src/utils/content-drm');

describe('content DRM (.aimc)', () => {
  test('packs ciphertext without embedding the plaintext or DEK', () => {
    const plain = Buffer.from('secret-chapter-bytes');
    const packed = packAimc({
      episodeId: 'ep1',
      productId: 'p1',
      mime: 'image/jpeg',
      filename: 'chuong-1',
      plain,
    });
    assert.equal(packed.subarray(0, 4).toString('utf8'), 'AIMC');
    assert.equal(packed.includes(plain), false);
    const header = parseAimcHeader(packed);
    assert.equal(header.v, 1);
    assert.equal(header.episodeId, 'ep1');
    assert.equal(header.mime, 'image/jpeg');
    assert.ok(header.iv);
    assert.ok(header.tag);
    assert.equal(JSON.stringify(header).includes(episodeDek('ep1').toString('base64')), false);

    const len = packed.readUInt32BE(4);
    const ciphertext = packed.subarray(8 + len);
    const roundtrip = decryptBuffer(
      {
        iv: Buffer.from(header.iv, 'base64'),
        tag: Buffer.from(header.tag, 'base64'),
        ciphertext,
      },
      'ep1',
    );
    assert.equal(roundtrip.toString('utf8'), 'secret-chapter-bytes');
  });

  test('wrong episode id cannot decrypt', () => {
    const packed = packAimc({
      episodeId: 'ep1',
      productId: 'p1',
      mime: 'video/mp4',
      filename: 'tap-1',
      plain: Buffer.from('film'),
    });
    const header = parseAimcHeader(packed);
    const len = packed.readUInt32BE(4);
    const ciphertext = packed.subarray(8 + len);
    assert.throws(() =>
      decryptBuffer(
        {
          iv: Buffer.from(header.iv, 'base64'),
          tag: Buffer.from(header.tag, 'base64'),
          ciphertext,
        },
        'ep-other',
      ),
    );
  });

  test('signed play tokens verify on another process without the in-memory map', () => {
    const token = issuePlayToken({
      episodeId: '64b000000000000000000001',
      productId: '64b000000000000000000002',
      licenseId: '64b000000000000000000003',
      mime: 'video/mp4',
    });
    playTokens.clear();
    const row = takePlayToken(token);
    assert.equal(row.episodeId, '64b000000000000000000001');
    assert.equal(row.mime, 'video/mp4');
    assert.equal(takePlayToken('not-a-token'), null);
    assert.equal(takePlayToken(encodeURIComponent(token)).episodeId, '64b000000000000000000001');
  });

  test('story chapters expose many frames and fall back to a single sourceUrl', () => {
    const pages = resolveEpisodePages({
      sourceUrl: 'https://example.com/cover.jpg',
      contentType: 'image/jpeg',
      pages: [
        { index: 2, sourceUrl: 'https://example.com/p2.jpg' },
        { index: 1, sourceUrl: 'https://example.com/p1.jpg' },
      ],
    });
    assert.equal(pages.length, 2);
    assert.equal(pages[0].index, 1);
    assert.equal(pages[1].sourceUrl, 'https://example.com/p2.jpg');
    const one = resolveEpisodePages({ sourceUrl: 'https://example.com/only.jpg', objectName: '' });
    assert.equal(one.length, 1);
    assert.equal(one[0].sourceUrl, 'https://example.com/only.jpg');
  });
});
