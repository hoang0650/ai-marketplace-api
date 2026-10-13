const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { settleSale } = require('../../src/finance/settlement-engine');
const { calculateCommission } = require('../../src/finance/commission-engine');
const { calculateTax } = require('../../src/finance/tax-engine');
const { reverseSettlement } = require('../../src/finance/refund-service');
const { canPayoutSeller } = require('../../src/finance/payout-engine');
const { claimEvent } = require('../../src/finance/idempotency');

const VN_INDIVIDUAL_PIT = {
  name: 'Test VN individual withholding',
  taxType: 'PIT',
  rate: 0.015,
  status: 'ACTIVE',
  sellerTypes: ['INDIVIDUAL'],
  sellerCountries: ['VN'],
  withholding: true,
};

const VN_COMPANY_VAT = {
  name: 'Test VN company VAT',
  taxType: 'VAT',
  rate: 0.1,
  status: 'ACTIVE',
  sellerTypes: ['COMPANY'],
  sellerCountries: ['VN'],
  withholding: false,
};

describe('Case 1 – individual seller', () => {
  test('20% commission plus TaxEngine PIT, not gross*0.8 as net', () => {
    const s = settleSale({
      unitPrice: 1_000_000,
      quantity: 1,
      ownershipType: 'THIRD_PARTY_SELLER',
      sellerTaxProfile: { sellerType: 'INDIVIDUAL', country: 'VN', withholdingRequired: true },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE', appliesTo: 'THIRD_PARTY_SELLER' }],
      currency: 'VND',
    });
    assert.equal(s.grossAmount, 1_000_000);
    assert.equal(s.commissionRate, 0.2);
    assert.equal(s.commissionAmount, 200_000);
    // Tax base is the price after discount (order gross), not the seller share.
    assert.equal(s.taxableAmount, 1_000_000);
    assert.equal(s.taxAmount, 15_000);
    assert.equal(s.sellerNetAmount, 785_000);
    assert.notEqual(s.sellerNetAmount, 800_000);
  });
});

describe('Case 2 – company seller', () => {
  test('different tax treatment than individual', () => {
    const individual = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      sellerTaxProfile: { sellerType: 'INDIVIDUAL', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT, VN_COMPANY_VAT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    const company = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      sellerTaxProfile: { sellerType: 'COMPANY', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT, VN_COMPANY_VAT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    assert.equal(individual.taxBreakdown[0].type, 'PIT');
    assert.equal(company.taxBreakdown[0].type, 'VAT');
    assert.notEqual(individual.taxAmount, company.taxAmount);
    assert.equal(company.commissionAmount, 200_000);
  });
});

describe('Case 3 – platform-owned product', () => {
  test('no third-party seller payable; full platform revenue', () => {
    const s = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'PLATFORM_DIRECT',
      sellerTaxProfile: { sellerType: 'PLATFORM', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    assert.equal(s.commissionAmount, 0);
    assert.equal(s.commissionRate, 0);
    assert.equal(s.sellerNetAmount, 0);
    assert.equal(s.platformRevenueAmount, 1_000_000);
  });
});

describe('Case 4 – refund reverses snapshot legs', () => {
  test('refund uses original commission/tax rates', () => {
    const original = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      sellerTaxProfile: { sellerType: 'INDIVIDUAL', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    const reversed = reverseSettlement({ ...original, ownershipType: 'THIRD_PARTY_SELLER' }, 1_000_000);
    assert.equal(reversed.commissionAmount, original.commissionAmount);
    assert.equal(reversed.taxAmount, original.taxAmount);
    assert.equal(reversed.sellerNetAmount, original.sellerNetAmount);
  });
});

describe('Case 5 – chargeback is an adjustment concept', () => {
  test('settlement can include chargeback without mutating original gross', () => {
    const original = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    const adjusted = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
      chargebackAmount: 100_000,
    });
    assert.equal(original.grossAmount, 1_000_000);
    assert.equal(adjusted.chargebackAmount, 100_000);
    assert.equal(adjusted.sellerNetAmount, original.sellerNetAmount - 100_000);
  });
});

describe('Case 6 – duplicate webhook', () => {
  test('claimEvent requires id', async () => {
    await assert.rejects(() => claimEvent({ eventId: '', provider: 'test', kind: 'webhook' }));
  });
});

describe('Case 7 – commission change does not rewrite snapshot math', () => {
  test('historical 20% stays when default rule becomes 15%', () => {
    const snapshot = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      commissionRules: [{ rate: 0.2, status: 'ACTIVE', name: 'old' }],
    });
    const later = calculateCommission({
      ownershipType: 'THIRD_PARTY_SELLER',
      grossAmount: 1_000_000,
      rules: [{ rate: 0.15, status: 'ACTIVE', name: 'new' }],
    });
    assert.equal(snapshot.commissionRate, 0.2);
    assert.equal(snapshot.commissionAmount, 200_000);
    assert.equal(later.rate, 0.15);
    assert.equal(later.commissionAmount, 150_000);
  });
});

describe('Case 8 – tax rule change does not rewrite snapshot', () => {
  test('old order keeps PIT 1.5% after rule becomes 2%', () => {
    const snapshot = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      sellerTaxProfile: { sellerType: 'INDIVIDUAL', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxRules: [VN_INDIVIDUAL_PIT],
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    const later = calculateTax({
      sellerTaxProfile: { sellerType: 'INDIVIDUAL', country: 'VN' },
      product: { taxCategory: 'AI_API' },
      taxableAmount: 1_000_000,
      rules: [{ ...VN_INDIVIDUAL_PIT, rate: 0.02 }],
    });
    assert.equal(snapshot.taxAmount, 15_000);
    assert.equal(later.totalTaxAmount, 20_000);
  });
});

describe('Case 9 – suspended seller payout hold', () => {
  test('SUSPENDED and unverified cannot payout', () => {
    assert.equal(canPayoutSeller({ verificationStatus: 'SUSPENDED' }).ok, false);
    assert.equal(canPayoutSeller({ verificationStatus: 'SUSPENDED' }).status, 'ON_HOLD');
    assert.equal(canPayoutSeller({ verificationStatus: 'PENDING' }).ok, false);
    assert.equal(canPayoutSeller({ verificationStatus: 'VERIFIED' }).ok, true);
  });
});

describe('Case 10 – foreign seller does not match VN-only rule', () => {
  test('US individual does not get VN PIT by default', () => {
    const tax = calculateTax({
      sellerTaxProfile: { sellerType: 'FOREIGN_INDIVIDUAL', country: 'US', taxResidency: 'US' },
      product: { taxCategory: 'AI_API' },
      taxableAmount: 1_000_000,
      rules: [VN_INDIVIDUAL_PIT],
    });
    assert.equal(tax.taxApplicable, false);
    assert.equal(tax.totalTaxAmount, 0);
    assert.equal(tax.reason, 'NO_MATCHING_TAX_RULE');
  });
});

test('default (individual, digital) tax is 7% of the price after discount - no flat 8%', () => {
  const s = settleSale({
    unitPrice: 1_000_000,
    ownershipType: 'THIRD_PARTY_SELLER',
    commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    taxRules: [],
  });
  assert.equal(s.commissionAmount, 200_000);
  assert.equal(s.taxableAmount, 1_000_000);
  assert.equal(s.taxAmount, 70_000);
  assert.equal(s.sellerNetAmount, 730_000);
  assert.equal(s.storeFeeAmount, 0);
  assert.equal(s.salesChannel, 'WEB');
});

describe('Case 11 – in-app (Google Play) order: no store fee, IAP is top-up only', () => {
  test('only 20% commission + 7% individual tax are deducted', () => {
    const s = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      salesChannel: 'CHPLAY',
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
      storeFeeRules: [{ salesChannel: 'GOOGLE_PLAY', rate: 0.15, status: 'ACTIVE' }],
    });
    assert.equal(s.salesChannel, 'GOOGLE_PLAY');
    assert.equal(s.storeFeeRate, 0);
    assert.equal(s.storeFeeAmount, 0);
    assert.equal(s.commissionAmount, 200_000);
    assert.equal(s.taxAmount, 70_000);
    assert.equal(s.sellerNetAmount, 730_000);
    assert.equal(s.platformRevenueAmount, 200_000);
  });
});

describe('Case 12 – in-app (App Store) order: no store fee', () => {
  test('seller net is the same as on the web', () => {
    const s = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'THIRD_PARTY_SELLER',
      salesChannel: 'APP_STORE',
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    assert.equal(s.salesChannel, 'APP_STORE');
    assert.equal(s.storeFeeAmount, 0);
    assert.equal(s.sellerNetAmount, 730_000);
  });
});

describe('Case 13 – Platform Direct in-app order: no store fee', () => {
  test('platform keeps the full proceeds; seller net stays 0', () => {
    const s = settleSale({
      unitPrice: 1_000_000,
      ownershipType: 'PLATFORM_DIRECT',
      salesChannel: 'APP_STORE',
      sellerTaxProfile: { sellerType: 'PLATFORM', country: 'VN' },
      commissionRules: [{ rate: 0.2, status: 'ACTIVE' }],
    });
    assert.equal(s.commissionAmount, 0);
    assert.equal(s.sellerNetAmount, 0);
    assert.equal(s.storeFeeAmount, 0);
    assert.equal(s.platformRevenueAmount, 1_000_000);
  });
});
