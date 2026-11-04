const test = require('node:test');
const assert = require('node:assert/strict');

const productRoutes = require('../../src/routes/products');

test('professional services require a whole-number delivery time from 1 to 365 days', () => {
  assert.equal(productRoutes.serviceDeliveryDays('hire-marketing', 7), 7);
  assert.equal(productRoutes.serviceDeliveryDays('hire-build-web', '30'), 30);
  assert.equal(productRoutes.serviceDeliveryDays('hire-seo', 0), null);
  assert.equal(productRoutes.serviceDeliveryDays('hire-creator', 1.5), null);
  assert.equal(productRoutes.serviceDeliveryDays('hire-workflow', 366), null);
  assert.equal(productRoutes.serviceDeliveryError('hire-build-app', undefined)?.code, 'SERVICE_DELIVERY_DAYS_REQUIRED');
});

test('non-service products do not require or persist a service delivery time', () => {
  assert.equal(productRoutes.serviceDeliveryDays('text-to-image', 7), null);
  assert.equal(productRoutes.serviceDeliveryError('text-to-image', undefined), null);
});
