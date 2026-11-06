const express = require('express');
const { findTenantByToken, touchTenantActivity } = require('../services/tenant-launch');
const { computeOpenClawSellCost } = require('../utils/openclaw-pricing');
const WalletTx = require('../models/WalletTx');
const mongoose = require('mongoose');
const { getAvailableBalance } = require('../utils/wallet');

/**
 * OpenAI-compatible proxy for platform-key mode.
 * The container presents its runtime token. The platform provider key stays
 * in this process and is never written to the response or to logs.
 */
const router = express.Router();

function platformConfig() {
  const baseUrl = String(process.env.AIMARKETS_PLATFORM_OPENAI_BASE_URL || '').replace(/\/$/, '');
  const apiKey = String(process.env.AIMARKETS_PLATFORM_OPENAI_KEY || '');
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match ? match[1] : '';
}

router.post('/chat/completions', async (req, res, next) => {
  try {
    const row = await findTenantByToken(bearer(req));
    if (!row) return res.status(401).json({ error: { message: 'Unauthorized' } });
    if (row.keySource === 'buyer') {
      return res.status(403).json({ error: { message: 'This runtime uses your own provider key.' } });
    }
    const platform = platformConfig();
    if (!platform) {
      return res.status(503).json({ error: { message: 'Platform model is not configured.', code: 'PLATFORM_KEY_UNAVAILABLE' } });
    }
    const oid = new mongoose.Types.ObjectId(String(row.user));
    const { available } = await getAvailableBalance(oid);
    if (available <= 0) {
      return res.status(402).json({ error: { message: 'Insufficient wallet for the platform model.' } });
    }
    await touchTenantActivity(row.user, row.agent);
    const upstream = await fetch(`${platform.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${platform.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    if (text.includes(platform.apiKey)) {
      console.warn(`[tenant-openai] upstream echoed a credential; response dropped user=${row.user}`);
      return res.status(502).json({ error: { message: 'Platform model response was rejected.' } });
    }
    if (!upstream.ok) {
      console.warn(`[tenant-openai] upstream HTTP ${upstream.status} user=${row.user}`);
      return res.status(upstream.status).type('application/json').send(text);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: { message: 'Platform model returned an unreadable response.' } });
    }
    const inputTokens = Math.max(0, Math.floor(Number(data?.usage?.prompt_tokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(data?.usage?.completion_tokens) || 0));
    const model = String(data?.model || req.body?.model || '');
    const cost = computeOpenClawSellCost({ model, inputTokens, outputTokens });
    if (cost > 0) {
      if (available + 1e-9 < cost) {
        return res.status(402).json({ error: { message: 'Insufficient wallet for the platform model.' } });
      }
      await WalletTx.create({
        user: oid,
        type: 'debit',
        amount: cost,
        currency: 'USD',
        note: `${row.agent} platform model ${model} in=${inputTokens} out=${outputTokens}`,
        meta: { channel: row.agent, audience: 'aimarkets', model, inputTokens, outputTokens, keySource: 'platform' },
      });
    }
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.platformConfig = platformConfig;
