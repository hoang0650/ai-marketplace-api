const mongoose = require('mongoose');
const { SELLER_TYPES } = require('../finance/seller-types');
const { TAX_CATEGORIES } = require('../finance/tax-category');

const taxRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    taxType: { type: String, required: true, trim: true, maxlength: 40, index: true },
    rate: { type: Number, required: true, min: 0, max: 1 },
    withholding: { type: Boolean, default: true },
    sellerTypes: { type: [String], default: [] },
    sellerCountries: { type: [String], default: [] },
    buyerCountries: { type: [String], default: [] },
    taxCategories: { type: [String], default: [] },
    jurisdictions: { type: [String], default: [] },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'INACTIVE', index: true },
  },
  { timestamps: true, collection: 'tax_rules' }
);

taxRuleSchema.index({ status: 1, taxType: 1, effectiveFrom: 1 });

module.exports = mongoose.model('TaxRule', taxRuleSchema);
module.exports.SELLER_TYPES = SELLER_TYPES;
module.exports.TAX_CATEGORIES = TAX_CATEGORIES;
