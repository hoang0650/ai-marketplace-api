const { discountForSubtotal, normalizeCode } = require('../../src/utils/coupon');

function test_normalize_strips_junk() {
  if (normalizeCode(' sale-20 ') !== 'SALE20') throw new Error('normalize');
}

function test_percent_and_cap() {
  const d = discountForSubtotal({ type: 'percent', value: 20, maxDiscount: 5 }, 100);
  if (d !== 5) throw new Error(`cap got ${d}`);
}

function test_amount_cannot_exceed_subtotal() {
  const d = discountForSubtotal({ type: 'amount', value: 40 }, 12);
  if (d !== 12) throw new Error(`amount got ${d}`);
}

function test_percent_90_max() {
  const d = discountForSubtotal({ type: 'percent', value: 50 }, 10);
  if (d !== 5) throw new Error(`percent got ${d}`);
}

test_normalize_strips_junk();
test_percent_and_cap();
test_amount_cannot_exceed_subtotal();
test_percent_90_max();
console.log('coupon math ok');
