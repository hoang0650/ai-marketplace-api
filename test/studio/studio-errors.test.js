const { test } = require('node:test');
const assert = require('node:assert/strict');
const { failMessage, transient } = require('../../src/utils/studio-errors');

test('tts failures say giọng nói, not video, and hide worker URLs', () => {
  const raw = "Server error '500 Internal Server Error' for url 'http://127.0.0.1:8801/tts'\nFor more information check: https://developer.mozilla.org/x";
  const m = failMessage('tts', raw, false);
  assert.match(m, /^Tạo giọng nói thất bại: /);
  assert.doesNotMatch(m, /http|127\.0\.0\.1|video/);
  assert.ok(transient(raw));
});

test('no-face error is explained; refund noted', () => {
  assert.equal(failMessage('talking', 'Exception: No face detected in the source image!', true),
    'Tạo video avatar thất bại: Không tìm thấy khuôn mặt người trong ảnh. Hãy dùng ảnh chân dung rõ mặt. (đã hoàn phí)');
  assert.equal(transient('No face detected'), false);
});

test('fast video keeps its label', () => {
  assert.match(failMessage('fast', '', false), /^Tạo video thất bại$/);
});
