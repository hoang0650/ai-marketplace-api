const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { placeHold, releaseHold } = require('../utils/wallet');
const { chargeUsage } = require('../finance/charge-usage');
const { resolveProviderForProduct, computeUsageCost, applyAllowedOverrides } = require('../utils/provider-resolve');
const { inferWithFallback } = require('../utils/denglish-client');
const { preflight } = require('../utils/usage-preflight');
const { charCount } = require('../utils/usage-pricing');
const { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } = require('../utils/idempotency');
const { publicProvider, scrubVendor, scrubVendorDeep } = require('../utils/white-label');
const { rehostMediaDeep, requestOrigin } = require('../utils/media-rehost');
const { productSlugQuery } = require('../utils/product-slug');
const {
  isVoiceProduct,
  voiceSampleUrl,
  hasVoiceSample,
  voiceAudioPublicUrl,
  voiceSamplePublicUrl,
  fetchMp3Buffer,
  putVoiceAudio,
  getVoiceAudio,
  sendMp3,
} = require('../utils/voice-audio');
const { voiceInferInput, isVoiceSttRequest } = require('../utils/voice-clone');
const {
  isVoiceCloneCategory,
  isVoicePresetCategory,
  isVoiceCategory,
  effectiveLicenseStatus,
  licenseCoversProduct,
} = require('../utils/license-keys');
const LicenseKey = require('../models/LicenseKey');
const aimxTts = require('../utils/aimx-tts');

const router = express.Router();

const MEDIA_FIELDS = ['image_url', 'video_url', 'audio_url'];

/**
 * Flatten the provider payload into the shape the playground UI renders:
 * one media URL (or text) plus the metering the buyer was charged for.
 */
function buildOutput(data, { kind, charged, providerCost, usage }) {
  if (!data || typeof data !== 'object') {
    return { kind: kind || 'text', text: String(data ?? ''), cost: charged };
  }

  const output = {
    kind: data.kind || kind || (MEDIA_FIELDS.find((f) => data[f]) || 'text').replace('_url', ''),
  };
  for (const field of MEDIA_FIELDS) {
    if (data[field]) output[field] = data[field];
  }
  if (Array.isArray(data.images) && data.images.length) output.images = data.images;
  if (data.text) output.text = data.text;
  if (data.seed !== undefined) output.seed = data.seed;
  if (data.job_id) output.jobId = data.job_id;
  if (data.raw_output !== undefined) output.rawOutput = data.raw_output;

  output.cost = charged;
  output.providerCost = providerCost;
  output.usage = {
    input: Number(usage.input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    unit: usage.unit,
    quantity: usage.quantity,
  };
  return output;
}

/** Our own wallet / idempotency errors keep their status; upstream errors map to 502. */
const PASS_THROUGH_CODES = new Set(['INSUFFICIENT_WALLET', 'PAYOUT_HELD', 'IDEMPOTENCY_IN_PROGRESS', 'WALLET_BUSY']);

function voiceText(inferInput) {
  return String(inferInput?.prompt || inferInput?.text || '').trim();
}

async function hasActiveVoiceLicense(buyerId, product) {
  const now = new Date();
  const licenses = await LicenseKey.find({ buyer: buyerId, product: product._id, status: 'active' })
    .sort({ expiresAt: -1 })
    .limit(5)
    .lean();
  return Boolean(
    licenses.find((l) => licenseCoversProduct(l, product._id) && effectiveLicenseStatus(l, now) === 'active')
  );
}

function insufficientBody(err, extra = {}) {
  return {
    message: err.message,
    code: err.code || 'INSUFFICIENT_WALLET',
    ...(err.body || {}),
    ...extra,
  };
}

/**
 * POST /api/playground/run
 * Body: { productSlug | productId, input, provider?, model?, endpointId?, action? }
 * provider/model/endpointId are hints honoured only when the listing allowlists them.
 * Header `Idempotency-Key` (or input.idempotencyKey): replays the first result for this buyer.
 * Auth: JWT — reserves the estimate, charges the wallet + records UsageEvent, proxies AI via denglish-api.
 */
router.post('/run', authenticate, async (req, res, next) => {
  let claim = null;
  let hold = null;
  try {
    const { productSlug, productId, input, action = 'runsync' } = req.body || {};

    if (!input || typeof input !== 'object') {
      return res.status(400).json({ message: 'input object is required' });
    }

    let product = null;
    if (productId) product = await Product.findById(productId);
    if (!product && productSlug) product = await Product.findOne(productSlugQuery(productSlug));
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const buyerId = req.user._id;
    const rawKey = req.headers['idempotency-key'] || input.idempotencyKey || input.idempotency_key;
    const idem = await claimIdempotencyKey(buyerId, 'playground', rawKey);
    if (idem.state === 'replay') {
      return res.json({ ...(idem.claim.response || {}), replay: true, cost: 0 });
    }
    claim = idem.claim;
    const scopedKey = claim ? `${buyerId}:${claim.key}` : undefined;

    let inferInput = input;
    const voice = isVoiceProduct(product);
    const stt = voice && isVoiceSttRequest(input);
    if (voice) {
      if (!stt && isVoiceCloneCategory(product.category) && !hasVoiceSample(product)) {
        return res.status(400).json({
          message: 'Seller has not uploaded a voice MP3 yet. Clone is pending.',
          code: 'VOICE_SAMPLE_MISSING',
        });
      }
      if (!stt && isVoicePresetCategory(product.category) && !String(product.contentMeta?.presetVoiceName || '').trim()) {
        return res.status(400).json({
          message: 'Preset voice is not configured on this listing.',
          code: 'VOICE_PRESET_MISSING',
        });
      }
      inferInput = voiceInferInput(product, input);
      if (!stt && !voiceText(inferInput)) {
        return res.status(400).json({ message: 'text is required', code: 'TEXT_REQUIRED' });
      }
    }

    const resolved = resolveProviderForProduct(product);
    const routed = applyAllowedOverrides(product, resolved, {
      provider: req.body?.provider,
      model: req.body?.model,
      endpointId: req.body?.endpointId,
    });
    const { provider, endpointId, model } = routed;

    if (voice && !stt && aimxTts.enabled() && !routed.rerouted) {
      const gpu = await runGpuVoice(req, product, inferInput);
      if (gpu) {
        await completeIdempotencyKey(claim, gpu.body, gpu.eventId);
        claim = null;
        return res.status(gpu.status || 200).json(gpu.body);
      }
      // GPU unavailable before billing — fall through to the serverless voice route.
    }

    const quote = await preflight({ provider, endpointId, model, input: inferInput });
    if (voice) quote.usage = { ...quote.usage, unit: 'characters', quantity: charCount(voiceText(inferInput)) };
    let estimatedCost = computeUsageCost(product, quote.usage, inferInput, quote.providerCost);
    let licenseCovered = false;
    if (isVoiceCategory(product.category) && estimatedCost > 0 && (await hasActiveVoiceLicense(buyerId, product))) {
      estimatedCost = 0;
      licenseCovered = true;
    }
    const sellerId = product.creator;
    const selfUse = String(buyerId) === String(sellerId);

    // Reserve the estimate atomically: 402 when available < estimatedCost, and parallel
    // requests can never jointly spend more than the wallet holds.
    if (estimatedCost > 0 && !selfUse) {
      try {
        hold = await placeHold(buyerId, estimatedCost, {
          note: `Playground (reserved): ${product.name}`,
          meta: { channel: 'playground', productId: String(product._id) },
        });
      } catch (err) {
        if (err.status === 402) {
          return res.status(402).json(
            insufficientBody(err, {
              message: `Insufficient available wallet balance (est. $${estimatedCost.toFixed(4)}). Please top up.`,
              estimatedCost,
              warnings: quote.warnings.length ? quote.warnings : undefined,
            })
          );
        }
        throw err;
      }
    }

    const started = Date.now();
    const ai = await inferWithFallback({
      provider,
      model,
      endpointId,
      input: inferInput,
      action,
      category: product.category,
      voiceSampleUrl: voiceSampleUrl(product),
      product: { category: product.category, contentMeta: product.contentMeta },
      buyerId: String(buyerId),
      idempotencyKey: scopedKey,
    });
    const latencyMs = Date.now() - started;

    const usage = ai.usage || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unit: 'tokens',
      quantity: 0,
    };
    if (voice) {
      usage.unit = 'characters';
      usage.quantity = charCount(voiceText(inferInput));
    }
    const sandbox = Boolean(ai.raw?.sandbox || ai.data?.sandbox);
    if (sandbox) usage.sandbox = true;
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const data = ai.data && typeof ai.data === 'object' ? ai.data : {};
    // denglish-api reports RunPod's own price as upstream_cost and the sell price
    // (upstream + markup) as cost, computed from output.cost when RunPod returns
    // one, otherwise from the formula on the model's docs page.
    const providerCost = sandbox ? 0 : Number(data.cost) || quote.providerCost || 0;
    const cost = licenseCovered || sandbox ? 0 : computeUsageCost(product, usage, inferInput, providerCost);

    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;
    let shortfall = 0;

    if (cost > 0 && !selfUse) {
      const billed = await chargeUsage({
        buyerId,
        sellerId,
        product,
        cost,
        holdId: hold?._id || null,
        funds: 'cap',
        note: `Playground: ${product.name}`,
      });
      hold = null;
      platformFee = billed.platformFee;
      sellerNet = billed.sellerNet;
      charged = billed.charged;
      shortfall = billed.shortfall || 0;
    } else if (hold) {
      await releaseHold(hold);
      hold = null;
    }

    const event = await UsageEvent.create({
      deployment: null,
      product: product._id,
      buyer: buyerId,
      seller: sellerId,
      inputTokens,
      outputTokens,
      cost: charged,
      platformFee,
      sellerNet,
      provider,
      unit: usage.unit || 'tokens',
      quantity: Number(usage.quantity) || 0,
      rawUsage: shortfall > 0 ? { ...usage, shortfall } : usage,
      source: 'playground',
      usageType: voice ? 'VOICE_TTS' : 'API_REQUEST',
    });

    const day = new Date().toISOString().slice(0, 10);
    await UsageStat.updateOne(
      { creator: sellerId, date: day },
      {
        $inc: {
          tokens: inputTokens + outputTokens,
          requests: 1,
          revenue: sellerNet,
        },
      },
      { upsert: true }
    ).catch(() => {});

    const output = buildOutput(data, {
      kind: voice ? 'audio' : ai.raw?.kind,
      charged,
      providerCost,
      usage,
    });

    if (voice) {
      output.kind = 'audio';
      output.format = String(output.format || data.format || 'wav').replace(/^mp3$/i, 'mp3');
      const prompt = String(inferInput?.prompt || '');
      if (prompt && !output.text) output.text = prompt;
      const remote = String(output.audio_url || data.audio_url || '').trim();
      if (remote) {
        try {
          const audio = await fetchMp3Buffer(remote);
          putVoiceAudio(event._id, audio.buffer, audio.contentType);
          output.audio_url = voiceAudioPublicUrl(req, event._id);
        } catch {
          output.audio_url = remote;
        }
      } else {
        output.audio_url = voiceSamplePublicUrl(req, product.slug);
        output.cloneFallback = 'sample';
      }
    }

    const publicOutput = await rehostMediaDeep(output, { baseUrl: requestOrigin(req) });

    const body = {
      ok: true,
      id: event._id.toString(),
      status: data.status || 'COMPLETED',
      provider: publicProvider(provider),
      model: ai.model || model,
      endpointId: ai.raw?.endpointId || endpointId,
      delayTime: Number(ai.raw?.delayTime) || 0,
      executionTime: Number(ai.raw?.executionTime) || ai.latency_ms || latencyMs,
      output: publicOutput,
      usage,
      cost: charged,
      providerCost,
      platformFee,
      sellerNet,
      currency: 'USD',
      warnings: ai.raw?.warnings?.length ? scrubVendorDeep(ai.raw.warnings) : undefined,
      sandbox,
      ignoredOverrides: routed.ignored.length ? routed.ignored : undefined,
    };
    await completeIdempotencyKey(claim, body, event._id);
    claim = null;
    res.json(body);
  } catch (err) {
    if (err.code === 'DENGLISH_NOT_CONFIGURED') {
      return res.status(503).json({ message: err.message });
    }
    if (err.name === 'AbortError') {
      return res.status(504).json({ message: 'denglish-api timeout' });
    }
    if (err.status && PASS_THROUGH_CODES.has(err.code)) {
      return res.status(err.status).json({ message: err.message, code: err.code, ...(err.body || {}) });
    }
    if (err.status) {
      return res.status(502).json({ message: scrubVendor(err.message), detail: scrubVendorDeep(err.body) });
    }
    next(err);
  } finally {
    if (hold) await releaseHold(hold);
    if (claim) await releaseIdempotencyKey(claim);
  }
});

/**
 * Voice listings speak through the AI Markets 5090: VieNeu-TTS (vi/en), Chatterbox (zh).
 * Returns { status?, body, eventId } to send, or null when the GPU is unreachable before
 * anything was billed (caller falls back to the serverless voice route).
 */
async function runGpuVoice(req, product, inferInput) {
  const text = voiceText(inferInput);
  if (!text) return { status: 400, body: { message: 'text is required', code: 'TEXT_REQUIRED' } };
  const lang = aimxTts.langOf(inferInput);
  const meta = product.contentMeta || {};
  let voice;
  let sampleBuffer;
  if (isVoicePresetCategory(product.category) || meta.voiceSource === 'preset') {
    voice = String(meta.presetVoiceId || meta.presetVoiceName || '').trim() || undefined;
  } else {
    sampleBuffer = (await fetchMp3Buffer(voiceSampleUrl(product))).buffer;
  }
  const buyerId = req.user._id;
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, unit: 'characters', quantity: charCount(text) };
  let cost = computeUsageCost(product, usage, inferInput, 0);
  if (cost > 0 && (await hasActiveVoiceLicense(buyerId, product))) cost = 0;
  const selfUse = String(buyerId) === String(product.creator);
  let hold = null;
  if (cost > 0 && !selfUse) {
    try {
      hold = await placeHold(buyerId, cost, {
        note: `Playground (reserved): ${product.name}`,
        meta: { channel: 'playground', productId: String(product._id) },
      });
    } catch (err) {
      if (err.status === 402) {
        return { status: 402, body: insufficientBody(err, { message: `Insufficient available wallet balance (need ${cost.toFixed(4)}).`, cost }) };
      }
      throw err;
    }
  }
  try {
    const started = Date.now();
    let audio;
    try {
      audio = await aimxTts.synth({ text, lang, voice, sampleBuffer, speed: inferInput?.speed, pitch: inferInput?.pitch });
    } catch (e) {
      if (!e.status || e.status >= 500) {
        console.warn('[playground] GPU voice unavailable, falling back:', e.status || e.code || e.message);
        return null;
      }
      return { status: e.status, body: { message: scrubVendor(e.message) } };
    }
    let charged = 0; let sellerNet = 0; let platformFee = 0;
    if (cost > 0 && !selfUse) {
      const billed = await chargeUsage({
        buyerId, sellerId: product.creator, product, cost, holdId: hold?._id || null, funds: 'cap', note: `Playground: ${product.name}`,
      });
      hold = null;
      ({ charged, sellerNet, platformFee } = billed);
    }
    const event = await UsageEvent.create({
      deployment: null, product: product._id, buyer: buyerId, seller: product.creator, inputTokens: 0, outputTokens: 0,
      cost: charged, platformFee, sellerNet, provider: 'aimx_gpu', unit: 'characters', quantity: usage.quantity, rawUsage: usage,
      source: 'playground', usageType: 'VOICE_TTS',
    });
    putVoiceAudio(event._id, audio.buffer, audio.contentType);
    return {
      eventId: event._id,
      body: {
        ok: true, id: event._id.toString(), status: 'COMPLETED', provider: 'AI Markets GPU', model: audio.model, endpointId: '',
        delayTime: 0, executionTime: Date.now() - started,
        output: { kind: 'audio', format: 'wav', text, audio_url: voiceAudioPublicUrl(req, event._id), timings: audio.timings, cost: charged },
        usage, cost: charged, providerCost: 0, platformFee, sellerNet, currency: 'USD',
      },
    };
  } finally {
    if (hold) await releaseHold(hold);
  }
}

router.get('/audio/:file', (req, res) => {
  const id = String(req.params.file || '').replace(/\.mp3$/i, '');
  const cached = getVoiceAudio(id);
  if (!cached) return res.status(404).json({ message: 'Audio expired. Run TTS again.' });
  return sendMp3(res, cached);
});

router.get('/voice/:file', async (req, res, next) => {
  try {
    const slug = String(req.params.file || '').replace(/\.mp3$/i, '').toLowerCase();
    const product = await Product.findOne({ slug }).lean();
    if (!product || !isVoiceProduct(product)) {
      return res.status(404).json({ message: 'Voice sample not found' });
    }
    const mp3 = await fetchMp3Buffer(voiceSampleUrl(product));
    return sendMp3(res, mp3);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
