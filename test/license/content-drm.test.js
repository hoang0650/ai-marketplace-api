const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  packAimc,
  parseAimcHeader,
  decryptBuffer,
  episodeDek,
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
});
