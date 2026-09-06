const AuditLog = require('../models/AuditLog');

async function writeAuditLog({
  actorId = null,
  actorRole = '',
  action,
  resourceType,
  resourceId = '',
  oldValue = null,
  newValue = null,
  ip = '',
  userAgent = '',
  reason = '',
}) {
  try {
    await AuditLog.create({
      actorId,
      actorRole,
      action,
      resourceType,
      resourceId: String(resourceId || ''),
      oldValue,
      newValue,
      ip,
      userAgent,
      reason,
    });
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

module.exports = { writeAuditLog };
