const { test } = require('node:test');
const assert = require('node:assert/strict');
const fl = require('../../src/utils/film-langs');
const filmRoutes = require('../../src/routes/studio-film');
const FilmProject = require('../../src/models/FilmProject');

const { sceneIn, renderPlan } = filmRoutes._internal;

test('catalog: vi + 23 Chatterbox languages, voices filtered per language', () => {
  const c = fl.catalog();
  assert.equal(c.languages.length, 24);
  assert.deepEqual(c.languages.slice(0, 3).map((l) => l.code), ['vi', 'en', 'zh']);
  assert.equal(c.languages.find((l) => l.code === 'vi').engine, 'vieneu');
  assert.equal(c.languages.find((l) => l.code === 'zh').font, 'Noto Sans CJK SC');
  assert.deepEqual(c.voices.vi.map((v) => v.id), ['Binh', 'Tuyen', 'Ly', 'Ngoc', 'Vinh', 'Doan']);
  assert.equal(c.voices.en[0].id, 'default');
  assert.equal(c.voices.en.length, 7);
  assert.deepEqual(c.subtitles, ['off', 'soft', 'burn']);
});

test('sceneVoice: scene override, project fallback, per-language voice fallback', () => {
  assert.deepEqual(fl.sceneVoice({ lang: 'vi' }, { voice: 'Ly' }), { lang: 'vi', voice: 'Ly' });
  assert.deepEqual(fl.sceneVoice({ lang: 'vi' }, { voice: 'Ly', lang: 'zh' }), { lang: 'zh', voice: 'Ly' });
  assert.deepEqual(fl.sceneVoice({ lang: 'en' }, { voice: 'default', lang: '' }), { lang: 'en', voice: 'default' });
  assert.deepEqual(fl.sceneVoice({ lang: 'vi' }, { voice: 'default' }), { lang: 'vi', voice: 'Binh' });
  assert.deepEqual(fl.sceneVoice({ lang: 'ja' }, { voice: 'Nobody' }), { lang: 'ja', voice: 'default' });
  assert.deepEqual(fl.sceneVoice({}, {}), { lang: 'vi', voice: 'Binh' });
  assert.equal(fl.filmLang('en-US'), 'en');
  assert.equal(fl.filmLang('xx'), '');
  assert.equal(fl.subtitleMode('burn'), 'burn');
  assert.equal(fl.subtitleMode('weird'), 'off');
});

test('sceneIn stores the optional per-scene language; billing stays per character', () => {
  const s = sceneIn({ narration: '你好世界', voice: 'Ly', lang: 'zh-CN', duration: 5 }, null);
  assert.equal(s.lang, 'zh');
  assert.equal(sceneIn({ lang: 'klingon' }, s).lang, '');
  const a = renderPlan({ scenes: [{ narration: '你好世界', lang: 'zh' }] });
  const b = renderPlan({ scenes: [{ narration: 'abcd', lang: 'vi' }] });
  assert.equal(a.chars, 4);
  assert.equal(a.price, b.price);
});

test('FilmProject schema: scene.lang defaults to inherit, subtitles off', () => {
  const p = new FilmProject({ user: '0'.repeat(24), scenes: [{ sid: 'a' }] });
  assert.equal(p.scenes[0].lang, '');
  assert.equal(p.subtitles, 'off');
  assert.ok(new FilmProject({ user: '0'.repeat(24), subtitles: 'nope' }).validateSync());
});
