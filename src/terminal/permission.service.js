const crypto = require('crypto');
const mongoose = require('mongoose');
const GpuServer = require('../models/GpuServer');
const TerminalAuditLog = require('../models/TerminalAuditLog');

const MAX_TERMINALS_PER_USER = Number(process.env.TERMINAL_MAX_SESSIONS || 3);
const MAX_GAMES_PER_USER = Number(process.env.GAME_MAX_SESSIONS || 2);
const SESSION_IDLE_MS = Number(process.env.TERMINAL_IDLE_MS || 30 * 60 * 1000);
const MAX_INPUT = Number(process.env.TERMINAL_MAX_INPUT || 8192);

function newSessionId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

async function assertServerOwner(user, serverId) {
  if (!serverId || !mongoose.Types.ObjectId.isValid(serverId)) {
    const err = new Error('SERVER_NOT_FOUND');
    err.status = 404;
    err.code = 'SERVER_NOT_FOUND';
    throw err;
  }
  const server = await GpuServer.findOne({ _id: serverId, owner: user._id });
  if (!server) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  return server;
}

async function audit(payload) {
  try {
    await TerminalAuditLog.create(payload);
  } catch (e) {
    console.warn('[audit]', e.message);
  }
}

module.exports = {
  MAX_TERMINALS_PER_USER,
  MAX_GAMES_PER_USER,
  SESSION_IDLE_MS,
  MAX_INPUT,
  newSessionId,
  assertServerOwner,
  audit,
};
