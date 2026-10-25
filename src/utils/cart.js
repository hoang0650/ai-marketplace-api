const MAX_QTY = 99;
const MAX_LINES = 100;

function clampQty(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_QTY, n));
}

function lineId(item) {
  return String(item?.product?._id || item?.product || '');
}

/**
 * Pure cart line update. mode 'add' increments, 'set' overwrites (qty 0 removes the line).
 * Returns a new array; never mutates the input.
 */
const TERMS = new Set(['day', 'month', 'year']);

function cleanTerm(term) {
  const t = String(term || '').trim().toLowerCase();
  return TERMS.has(t) ? t : '';
}

function copyLine(it) {
  return { product: lineId(it), qty: it.qty, addedAt: it.addedAt, licenseTerm: cleanTerm(it.licenseTerm) };
}

/** `term` (day/month/year) replaces the line's license period when given; otherwise it is kept. */
function applyCartLine(items, productId, qty, mode = 'add', now = new Date(), term) {
  const id = String(productId);
  const nextTerm = cleanTerm(term);
  const list = (items || []).map(copyLine);
  const idx = list.findIndex((it) => it.product === id);
  const current = idx >= 0 ? list[idx].qty : 0;
  const next = clampQty(mode === 'set' ? qty : current + (Number(qty) || 1));
  if (next <= 0) {
    if (idx >= 0) list.splice(idx, 1);
    return list;
  }
  if (idx >= 0) {
    list[idx] = { ...list[idx], qty: next, licenseTerm: nextTerm || list[idx].licenseTerm };
    return list;
  }
  if (list.length >= MAX_LINES) {
    const err = new Error('Cart is full');
    err.statusCode = 400;
    throw err;
  }
  list.push({ product: id, qty: next, addedAt: now, licenseTerm: nextTerm });
  return list;
}

function removeCartLines(items, productIds) {
  const drop = new Set((productIds || []).map(String));
  return (items || [])
    .filter((it) => !drop.has(lineId(it)))
    .map(copyLine);
}

module.exports = { MAX_QTY, MAX_LINES, clampQty, cleanTerm, applyCartLine, removeCartLines, lineId };
