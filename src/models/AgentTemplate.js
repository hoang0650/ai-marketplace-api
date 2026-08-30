const mongoose = require('mongoose');

/** Generic agent runtime template — OpenClaw/Hermes/SpaceBot are rows, not core code. */
const schema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    repository: { type: String, default: '' },
    dockerImage: { type: String, default: '' },
    version: { type: String, default: '1.0.0' },
    environmentVariables: { type: [String], default: [] },
    ports: { type: [Number], default: [8080] },
    volumes: { type: [String], default: [] },
    requiredGPU: { type: String, default: '' },
    requiredCPU: { type: Number, default: 2 },
    requiredRAM: { type: Number, default: 8 },
    providerRequirements: { type: [String], default: ['CONTAINER', 'GPU_COMPUTE'] },
    startupCommand: { type: String, default: '' },
    healthCheck: { type: String, default: '' },
    configurationSchema: { type: mongoose.Schema.Types.Mixed, default: {} },
    published: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

schema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
schema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('AgentTemplate', schema);
