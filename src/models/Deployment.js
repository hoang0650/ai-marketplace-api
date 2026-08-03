const mongoose = require('mongoose');

/**
 * A user-configured deployment of a marketplace product:
 * - kind 'model'  → serverless model endpoint (Featherless-style)
 * - kind 'agent'  → configured agent published to the Agent Browser
 */
const deploymentSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
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
    /** Published to the public Agent Browser */
    visibility: { type: String, enum: ['private', 'public'], default: 'private', index: true },
    config: {
      baseModel: { type: String, default: '' },
      systemPrompt: { type: String, default: '', maxlength: 4000 },
      temperature: { type: Number, default: 0.7, min: 0, max: 2 },
      maxTokens: { type: Number, default: 1024, min: 1, max: 32768 },
      tools: { type: [String], default: [] },
    },
    apiKey: { type: String, required: true },
    endpoint: { type: String, required: true },
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

deploymentSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
deploymentSchema.set('toJSON', { virtuals: true });
deploymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Deployment', deploymentSchema);
