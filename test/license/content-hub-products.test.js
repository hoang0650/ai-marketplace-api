const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildContentHubProducts,
  buildContentHubEpisodes,
  playableSourceUrl,
  hubProductFields,
} = require('../../src/data/content-hub-products');

describe('content hub seed products', () => {
  const products = buildContentHubProducts();

  test('covers voice clone, watch films, and stories', () => {
    const cats = products.map((p) => p.category);
    assert.equal(cats.filter((c) => c === 'voice-clone').length, 4);
    assert.equal(cats.filter((c) => c === 'ai-film-series').length, 4);
    assert.equal(cats.filter((c) => c === 'story-book').length, 4);
    assert.equal(cats.includes('text-to-video'), false);
    assert.equal(cats.includes('image-to-video'), false);
  });

  test('voices bill by character and expose sample URL', () => {
    const voices = products.filter((p) => p.category === 'voice-clone').map(hubProductFields);
    for (const p of voices) {
      assert.equal(p.contentMeta.kind, 'voice');
      assert.ok(p.contentMeta.voiceModes.includes('tts'));
      assert.ok(p.contentMeta.voiceSampleUrl);
      assert.equal(p.pricing.model, 'usage');
      assert.equal(p.productType, 'VOICE');
    }
  });

  test('films and stories use day/month/year license prices', () => {
    const licensed = products
      .filter((p) => p.category === 'ai-film-series' || p.category === 'story-book')
      .map(hubProductFields);
    for (const p of licensed) {
      assert.ok(p.contentMeta.licensePrices.day > 0);
      assert.ok(p.contentMeta.licensePrices.month > 0);
      assert.ok(p.contentMeta.licensePrices.year > 0);
      assert.ok(p.contentMeta.episodeCount > 0);
      assert.equal(p.productType, 'MEDIA_LICENSE');
      assert.equal(p.contentMeta.kind, p.category === 'story-book' ? 'story' : 'series');
    }
  });

  test('hub episodes cover seeded films and stories without public media URLs in catalog meta', () => {
    const packs = buildContentHubEpisodes();
    const slugs = packs.map((p) => p.productSlug);
    assert.equal(slugs.length, 8);
    assert.ok(slugs.includes('neon-harbor'));
    assert.ok(slugs.includes('iron-lotus'));
    assert.ok(slugs.includes('dem-ha-noi'));
    assert.ok(slugs.includes('mat-thu-mekong'));
    for (const pack of packs) {
      assert.ok(pack.items.length >= 3);
      for (const item of pack.items) {
        assert.ok(item.title);
        assert.ok(item.sourceUrl);
        assert.equal(/gtv-videos-bucket/i.test(item.sourceUrl), false);
        assert.match(item.kind, /^(video|image)$/);
        if (item.kind === 'image') {
          assert.ok(Array.isArray(item.pages));
          assert.ok(item.pages.length >= 8, `${item.title} should have many story frames`);
        }
      }
    }
  });

  test('maps retired Google sample-bucket URLs onto working public MP4s', () => {
    const next = playableSourceUrl(
      'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      2,
    );
    assert.match(next, /^https:\/\/(media\.w3\.org|interactive-examples\.mdn\.mozilla\.net|www\.w3schools\.com)\//);
    assert.equal(
      playableSourceUrl('https://media.w3.org/2010/05/sintel/trailer.mp4', 0),
      'https://media.w3.org/2010/05/sintel/trailer.mp4',
    );
  });
});
