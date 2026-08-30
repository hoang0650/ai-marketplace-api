const crypto = require('crypto');
const mongoose = require('mongoose');

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

function mintKey() {
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `mk_live_${secret}`;
  return { plaintext, prefix: plaintext.slice(0, 16), keyHash: hashKey(plaintext) };
}

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productSlug: { type: String, required: true, index: true },
    name: { type: String, default: 'default', trim: true, maxlength: 80 },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
schema.set('toJSON', { virtuals: true });

const MarketplaceApiKey = mongoose.model('MarketplaceApiKey', schema);
MarketplaceApiKey.hashKey = hashKey;
MarketplaceApiKey.mintKey = mintKey;

module.exports = MarketplaceApiKey;
