const mongoose = require('mongoose');

/**
 * Which of the buyer's BYOK keys (ProviderApiKey) a hosted agent runs on, and with which model.
 * No row = the agent uses the AI Markets default model.
 */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    agent: { type: String, required: true, enum: ['nanoclaw', 'hermes'] },
    provider: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    model: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { timestamps: true }
);

schema.index({ user: 1, agent: 1 }, { unique: true });

schema.methods.toPublic = function toPublic() {
  return { provider: this.provider, model: this.model, updatedAt: this.updatedAt };
};

module.exports = mongoose.model('AgentProviderSetting', schema);
