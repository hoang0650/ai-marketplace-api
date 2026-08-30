const STATUSES = ['active', 'suspended', 'blocked', 'inactive'];

function clampDays(n) {
  const d = Number(n);
  if (!Number.isFinite(d)) return 7;
  return Math.min(365, Math.max(1, Math.round(d)));
}

function effectiveStatus(doc, field = 'accountStatus') {
  const s = doc[field] || 'active';
  if (s === 'suspended' && doc.suspendedUntil && new Date(doc.suspendedUntil) <= new Date()) {
    return 'active';
  }
  return s;
}

function applyStatus(doc, { status, days, reason }, field = 'accountStatus') {
  if (!STATUSES.includes(status)) {
    const err = new Error('Invalid status');
    err.status = 400;
    throw err;
  }
  doc[field] = status;
  doc.statusReason = String(reason || '').slice(0, 500);
  doc.statusChangedAt = new Date();
  if (status === 'suspended') {
    const d = clampDays(days);
    doc.suspendedUntil = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
  } else {
    doc.suspendedUntil = null;
  }
  if (field === 'moderationStatus') {
    doc.published = status === 'active';
  }
  return doc;
}

async function liftExpired(doc, field = 'accountStatus') {
  if ((doc[field] || 'active') !== 'suspended') return doc;
  if (doc.suspendedUntil && new Date(doc.suspendedUntil) <= new Date()) {
    doc[field] = 'active';
    doc.suspendedUntil = null;
    doc.statusReason = 'Suspension expired';
    await doc.save().catch(() => {});
  }
  return doc;
}

function denyMessage(status) {
  if (status === 'blocked') return 'Account is blocked';
  if (status === 'inactive') return 'Account is inactive';
  if (status === 'suspended') return 'Account is suspended';
  return 'Account is not allowed';
}

function catalogVisibleFilter() {
  const now = new Date();
  return {
    $and: [
      { $or: [{ published: true }, { published: { $exists: false } }] },
      {
        $or: [
          { moderationStatus: { $exists: false } },
          { moderationStatus: 'active' },
          { moderationStatus: 'suspended', suspendedUntil: { $lte: now } },
        ],
      },
    ],
  };
}

function isCatalogVisible(product) {
  const pub = product.published !== false;
  const s = effectiveStatus(product, 'moderationStatus');
  return pub && s === 'active';
}

module.exports = {
  STATUSES,
  effectiveStatus,
  applyStatus,
  liftExpired,
  denyMessage,
  catalogVisibleFilter,
  isCatalogVisible,
};
