const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMongoId, hasWishlistId, wishlistIdsOf } = require('../../src/utils/wishlist');

test('isMongoId accepts 24-hex ids only (not 12-char slugs)', () => {
  assert.equal(isMongoId('507f1f77bcf86cd799439011'), true);
  assert.equal(isMongoId('kimi-k3-chat'), false);
  assert.equal(isMongoId('wan-2-5'), false);
  assert.equal(isMongoId(''), false);
});

test('hasWishlistId compares ObjectId and string forms', () => {
  const productId = '507f1f77bcf86cd799439011';
  const user = { wishlist: [{ _id: productId }, '507f1f77bcf86cd799439012'] };
  assert.equal(hasWishlistId(user, productId), true);
  assert.equal(hasWishlistId(user, '507f1f77bcf86cd799439012'), true);
  assert.equal(hasWishlistId(user, '507f1f77bcf86cd799439099'), false);
  assert.deepEqual(wishlistIdsOf(user), [productId, '507f1f77bcf86cd799439012']);
});
