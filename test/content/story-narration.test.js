const test = require('node:test');
const assert = require('node:assert');
const { segment, paragraphs, fnv } = require('../../src/utils/story-narration');
const { providerPath } = require('../../src/utils/aimx-gpu');

test('paragraphs match the reader split (blank lines, markdown headings, whitespace)', () => {
  assert.deepStrictEqual(paragraphs('# Chương 1\r\n\r\nMột   hai.\nba.\n\n\n  \nBốn'), ['Chương 1', 'Một hai. ba.', 'Bốn']);
  assert.deepStrictEqual(paragraphs('<p>A &amp; B</p><h2>C</h2>', 'text/html'), ['A & B', 'C']);
});

test('segments index the paragraph text exactly and skip unspeakable bits', () => {
  const raw = 'Chương 1: Ngọn hải đăng\n\nNgày xưa, ở một làng chài nhỏ, có ngọn hải đăng. Ông Tư ngày nào cũng leo lên thắp đèn! "Ồ!" — bé Na reo lên.\n\n***';
  const r = segment(raw, 'text/plain');
  assert.strictEqual(r.paras.length, 3);
  assert.strictEqual(r.paraSig.length, 3);
  for (const s of r.segments) assert.strictEqual(r.paras[s.p].slice(s.c0, s.c1), s.text);
  assert.ok(r.segments.every((s) => s.p !== 2));
  assert.deepStrictEqual(r.segments.map((s) => s.p), [0, 1, 1, 1]);
});

test('long sentences split under the TTS cap; ids are sequential', () => {
  const long = Array.from({ length: 60 }, (_, i) => `mệnh đề số ${i}`).join(', ') + '.';
  const r = segment(long);
  assert.ok(r.segments.length > 1);
  assert.ok(r.segments.every((s) => s.text.length <= 360));
  assert.deepStrictEqual(r.segments.map((s) => s.id), r.segments.map((_, i) => String(i)));
});

test('fnv is stable (mirrored in the web reader)', () => {
  assert.strictEqual(fnv(''), '811c9dc5');
  assert.strictEqual(fnv('a'), 'e40c292c');
});

test('narration path is routed to the AI film service', () => {
  assert.strictEqual(providerPath('/film/narration'), '/providers/aimx/film/narration');
});
