const { test } = require('node:test');
const assert = require('node:assert/strict');
const { containsBlockedLink, isAllowedChatImageUrl } = require('../../src/utils/chat-security');

test('blocks http(s) and www links', () => {
  assert.equal(containsBlockedLink('xem https://evil.com/x'), true);
  assert.equal(containsBlockedLink('www.phishing.vn'), true);
  assert.equal(containsBlockedLink('liên hệ t.me/abc'), true);
  assert.equal(containsBlockedLink('[click](https://x.com)'), true);
  assert.equal(containsBlockedLink('shop.example.com'), true);
});

test('allows normal product questions', () => {
  assert.equal(containsBlockedLink('Sản phẩm này hỗ trợ GPU 24GB không?'), false);
  assert.equal(containsBlockedLink('Giá 20 USD / tháng, có giảm không?'), false);
  assert.equal(containsBlockedLink(''), false);
});

test('only marketplace image hosts are allowed as imageUrl', () => {
  assert.equal(isAllowedChatImageUrl('https://cdn.aimarkets.vn/aimarkets/aimarkets/playground/a.jpg'), true);
  assert.equal(isAllowedChatImageUrl('https://minio.phhotel.vn/playground/a.jpg'), false);
  assert.equal(isAllowedChatImageUrl('https://evil.com/a.jpg'), false);
  assert.equal(isAllowedChatImageUrl('javascript:alert(1)'), false);
});
