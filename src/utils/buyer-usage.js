/**
 * Buyer-facing usage feed helpers (OpenClaw/Hermes WalletTx + product UsageEvent).
 */

const { publicProvider } = require('./white-label');

const AGENT_NOTE_RE =
  /^(OpenClaw|Hermes)\s+(\S+)\s+\(\+(\d+)%[^)]*\)\s+in=(\d+)\s+out=(\d+)/i;

function parseAgentUsageNote(note) {
  const m = String(note || '').match(AGENT_NOTE_RE);
  if (!m) {
    if (/^(OpenClaw|Hermes)\b/i.test(String(note || ''))) {
      const channel = /^Hermes\b/i.test(String(note || '')) ? 'hermes' : 'openclaw';
      return { channel, model: '', inputTokens: 0, outputTokens: 0, markup: null };
    }
    return null;
  }
  return {
    channel: String(m[1] || 'openclaw').toLowerCase() === 'hermes' ? 'hermes' : 'openclaw',
    model: m[2] || '',
    markup: Number(m[3]) / 100,
    inputTokens: Math.max(0, Number(m[4]) || 0),
    outputTokens: Math.max(0, Number(m[5]) || 0),
  };
}

/** @deprecated use parseAgentUsageNote */
function parseOpenClawNote(note) {
  const p = parseAgentUsageNote(note);
  if (!p) return null;
  return {
    model: p.model,
    markup: p.markup,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
  };
}

function mapAgentWalletTx(tx) {
  const meta = tx.meta && typeof tx.meta === 'object' ? tx.meta : null;
  const channelFromMeta =
    meta?.channel === 'hermes' || meta?.channel === 'openclaw' ? meta.channel : null;
  const parsed = channelFromMeta
    ? {
        channel: channelFromMeta,
        model: String(meta.model || ''),
        inputTokens: Math.max(0, Math.floor(Number(meta.inputTokens) || 0)),
        outputTokens: Math.max(0, Math.floor(Number(meta.outputTokens) || 0)),
        markup: Number.isFinite(Number(meta.markup)) ? Number(meta.markup) : null,
      }
    : parseAgentUsageNote(tx.note);
  if (!parsed && !channelFromMeta) return null;
  const channel = parsed?.channel || channelFromMeta || 'openclaw';
  const inputTokens = parsed?.inputTokens ?? 0;
  const outputTokens = parsed?.outputTokens ?? 0;
  return {
    id: String(tx._id || tx.id),
    createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : new Date().toISOString(),
    source: channel,
    channel,
    model: parsed?.model || meta?.model || '',
    productId: null,
    productName: '',
    productSlug: '',
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
    amount: Number(tx.amount) || 0,
    currency: tx.currency || 'USD',
    note: tx.note || '',
    markup: parsed?.markup ?? null,
  };
}

function mapOpenClawTx(tx) {
  return mapAgentWalletTx(tx);
}

function mapUsageEvent(ev) {
  const product = ev.product && typeof ev.product === 'object' ? ev.product : null;
  const inputTokens = Math.max(0, Math.floor(Number(ev.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(ev.outputTokens) || 0));
  return {
    id: String(ev._id || ev.id),
    createdAt: ev.createdAt ? new Date(ev.createdAt).toISOString() : new Date().toISOString(),
    source: String(ev.source || 'api'),
    channel: String(ev.source || 'api'),
    model: String(publicProvider(ev.provider) || ''),
    productId: product ? String(product._id || product.id || '') : ev.product ? String(ev.product) : null,
    productName: product?.name || '',
    productSlug: product?.slug || '',
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
    amount: Number(ev.cost) || 0,
    currency: ev.currency || 'USD',
    note: product?.name ? `${ev.source || 'usage'}: ${product.name}` : String(ev.usageType || ev.source || 'usage'),
    markup: null,
  };
}

function summarizeUsageItems(items) {
  return items.reduce(
    (acc, row) => {
      acc.requests += 1;
      acc.totalCharged += Number(row.amount) || 0;
      acc.totalInputTokens += Number(row.inputTokens) || 0;
      acc.totalOutputTokens += Number(row.outputTokens) || 0;
      acc.totalTokens += Number(row.tokens) || 0;
      return acc;
    },
    {
      requests: 0,
      totalCharged: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
  );
}

module.exports = {
  OPENCLAW_NOTE_RE: AGENT_NOTE_RE,
  AGENT_NOTE_RE,
  parseOpenClawNote,
  parseAgentUsageNote,
  mapOpenClawTx,
  mapAgentWalletTx,
  mapUsageEvent,
  summarizeUsageItems,
};
