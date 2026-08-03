const mongoose = require('mongoose');

const envVarSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 128 },
    value: { type: String, default: '', maxlength: 4000 },
  },
  { _id: false }
);

/**
 * Seller-owned live deployment of a marketplace product.
 * Runtime mirrors Product.runtime and can be updated independently:
 * RunPod serverless, tokenize meter, gateway, public endpoint, .env, skills.
 */
const deploymentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productSlug: { type: String, required: true },
    productName: { type: String, required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['model', 'agent'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['provisioning', 'running', 'stopped'],
      default: 'provisioning',
      index: true,
    },
    visibility: { type: String, enum: ['private', 'public'], default: 'private', index: true },
    runtime: {
      serverlessEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
      tokenizeEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
      gatewayUrl: { type: String, default: '', trim: true, maxlength: 500 },
      publicEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
      env: { type: [envVarSchema], default: [] },
      skills: { type: [String], default: [] },
      baseModel: { type: String, default: '', trim: true, maxlength: 200 },
      systemPrompt: { type: String, default: '', maxlength: 4000 },
      temperature: { type: Number, default: 0.7, min: 0, max: 2 },
      maxTokens: { type: Number, default: 1024, min: 1, max: 32768 },
    },
    /** Marketplace-issued key for buyers invoking via our platform. */
    apiKey: { type: String, required: true },
    totals: {
      requests: { type: Number, default: 0 },
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

deploymentSchema.index({ visibility: 1, status: 1, kind: 1 });
deploymentSchema.index({ seller: 1, createdAt: -1 });

deploymentSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
deploymentSchema.set('toJSON', { virtuals: true });
deploymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Deployment', deploymentSchema);
