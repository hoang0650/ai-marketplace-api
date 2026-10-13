const mongoose = require('mongoose');

/**
 * Single-use, short-lived Hermes Launch ticket. Only the SHA-256 of the ticket is stored;
 * the raw value travels once in the Launch URL fragment and is consumed by
 * POST /v1/hermes/auth/verify (Hermes aimarkets auth provider).
 */
const hermesLoginTicketSchema = new mongoose.Schema({
  hash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
});

// Mongo TTL cleanup; consumption also checks expiresAt so the TTL sweep delay does not matter.
hermesLoginTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('HermesLoginTicket', hermesLoginTicketSchema);
