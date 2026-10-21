const express = require('express');
const Product = require('../models/Product');
const UsageEvent = require('../models/UsageEvent');
const UsageStat = require('../models/UsageStat');
const { authenticate } = require('../middleware/auth');
const { getAvailableBalance } = require('../utils/wallet');
const { chargeUsage } = require('../finance/charge-usage');
const { resolveProviderForProduct, computeUsageCost } = require('../utils/provider-resolve');
const { inferWithFallback, quoteInference } = require('../utils/denglish-client');
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
 * Ask denglish-api for the exact RunPod payload and the price.
 *
 * `providerCost` is the sell price (RunPod's documented cost plus the configured
 * markup); `upstreamCost` is what RunPod itself charges and is never returned to clients.
 * Falls back to a coarse local guess when denglish-api or the catalog can't help.
 */
async function preflight({ provider, endpointId, model, input }) {
  if (provider === 'runpod_public') {
    try {
      const q = await quoteInference({ model: endpointId || model, input });
      return {
        usage: { unit: q.unit, quantity: q.quantity, total_tokens: 0 },
        providerCost: Number(q.estimatedCost) || 0,
        upstreamCost: Number(q.upstreamCost) || 0,
        markup: Number(q.markup) || 0,
        warnings: q.warnings || [],
      };
    } catch {
      /* denglish-api unavailable — fall through to the local guess */
    }
  }
  const roughTokens = Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
  const unit = input.duration ? 'seconds' : input.image && !input.prompt ? 'images' : 'tokens';
  return {
    usage: {
      unit,
      quantity: input.duration || (input.image ? 1 : roughTokens),
      total_tokens: roughTokens,
    },
    providerCost: 0,
    upstreamCost: 0,
    markup: 0,
    warnings: [],
  };
}

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

/**
 * POST /api/playground/run
 * Body: { productSlug | productId, input, provider?, model?, endpointId?, action? }
 * Auth: JWT — charges wallet + records UsageEvent, proxies AI via denglish-api.
 */
router.post('/run', authenticate, async (req, res, next) => {
  try {
    const {
      productSlug,
      productId,
      input,
      provider: providerOverride,
      model: modelOverride,
      endpointId: endpointOverride,
      action = 'runsync',
    } = req.body || {};

    if (!input || typeof input !== 'object') {
      return res.status(400).json({ message: 'input object is required' });
    }

    let product = null;
    if (productId) product = await Product.findById(productId);
    if (!product && productSlug) product = await Product.findOne(productSlugQuery(productSlug));
    if (!product) return res.status(404).json({ message: 'Product not found' });

    let inferInput = input;
    if (isVoiceProduct(product)) {
      const stt = isVoiceSttRequest(input);
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
    }

    if (isVoiceProduct(product) && !isVoiceSttRequest(input) && aimxTts.enabled() && !providerOverride && !modelOverride) {
      return await runGpuVoice(req, res, product, inferInput);
    }

    const resolved = resolveProviderForProduct(product);
    const provider = providerOverride || resolved.provider;
    const endpointId = endpointOverride || resolved.endpointId;
    const model = modelOverride || resolved.model;

    const quote = await preflight({ provider, endpointId, model, input: inferInput });
    let estimatedCost = computeUsageCost(product, quote.usage, inferInput, quote.providerCost);
    let licenseCovered = false;
    if (isVoiceCategory(product.category) && estimatedCost > 0) {
      const now = new Date();
      const licenses = await LicenseKey.find({
        buyer: req.user._id,
        product: product._id,
        status: 'active',
      })
        .sort({ expiresAt: -1 })
        .limit(5)
        .lean();
      const active = licenses.find(
        (l) => licenseCoversProduct(l, product._id) && effectiveLicenseStatus(l, now) === 'active',
      );
      if (active) {
        estimatedCost = 0;
        licenseCovered = true;
      }
    }
    if (estimatedCost > 0) {
      const { available, balance, held } = await getAvailableBalance(req.user._id);
      if (available < estimatedCost * 0.5 && available < 0.001) {
        return res.status(402).json({
          message: `Insufficient available wallet balance (est. $${estimatedCost.toFixed(4)}). Please top up.`,
          estimatedCost,
          balance,
          available,
          held,
          warnings: quote.warnings.length ? quote.warnings : undefined,
        });
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
      buyerId: String(req.user._id),
      idempotencyKey: inferInput.idempotencyKey || inferInput.idempotency_key,
    });
    const latencyMs = Date.now() - started;

    const usage = ai.usage || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      unit: 'tokens',
      quantity: 0,
    };
    if (isVoiceProduct(product)) {
      const chars = Math.max(1, String(inferInput?.prompt || inferInput?.text || '').length);
      usage.unit = 'characters';
      usage.quantity = chars;
    }
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const data = ai.data && typeof ai.data === 'object' ? ai.data : {};
    // denglish-api reports RunPod's own price as upstream_cost and the sell price
    // (upstream + markup) as cost, computed from output.cost when RunPod returns
    // one, otherwise from the formula on the model's docs page.
    const providerCost = Number(data.cost) || quote.providerCost || 0;
    let cost = licenseCovered ? 0 : computeUsageCost(product, usage, inferInput, providerCost);

    const buyerId = req.user._id;
    const sellerId = product.creator;
    const selfUse = String(buyerId) === String(sellerId);

    let charged = 0;
    let sellerNet = 0;
    let platformFee = 0;

    if (cost > 0 && !selfUse) {
      const { available, balance, held } = await getAvailableBalance(buyerId);
      if (available < cost) {
        return res.status(402).json({
          message: `Insufficient available wallet balance (need $${cost.toFixed(4)}, have $${available.toFixed(4)}).`,
          cost,
          balance,
          available,
          held,
          usage,
        });
      }
      const billed = await chargeUsage({
        buyerId,
        sellerId,
        product,
        cost,
        note: `Playground: ${product.name}`,
      });
      platformFee = billed.platformFee;
      sellerNet = billed.sellerNet;
      charged = billed.charged;
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
      rawUsage: usage,
      source: 'playground',
      usageType: isVoiceProduct(product) ? 'VOICE_TTS' : 'API_REQUEST',
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
      kind: isVoiceProduct(product) ? 'audio' : ai.raw?.kind,
      charged,
      providerCost,
      usage,
    });

    if (isVoiceProduct(product)) {
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

    res.json({
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
      sandbox: Boolean(ai.raw?.sandbox),
    });
  } catch (err) {
    if (err.code === 'DENGLISH_NOT_CONFIGURED') {
      return res.status(503).json({ message: err.message });
    }
    if (err.name === 'AbortError') {
      return res.status(504).json({ message: 'denglish-api timeout' });
    }
    if (err.status) {
      return res.status(502).json({ message: scrubVendor(err.message), detail: scrubVendorDeep(err.body) });
    }
    next(err);
  }
});

/** Voice listings speak through the AI Markets 5090: VieNeu-TTS (vi/en), Chatterbox (zh). */
async function runGpuVoice(req, res, product, inferInput) {
  const text = String(inferInput?.prompt || inferInput?.text || '').trim();
  if (!text) return res.status(400).json({ message: 'text is required' });
  const lang = aimxTts.langOf(inferInput);
  const meta = product.contentMeta || {};
  let voice;
  let sampleBuffer;
  if (isVoicePresetCategory(product.category) || meta.voiceSource === 'preset') {
    voice = String(meta.presetVoiceId || meta.presetVoiceName || '').trim() || undefined;
  } else {
    sampleBuffer = (await fetchMp3Buffer(voiceSampleUrl(product))).buffer;
  }
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, unit: 'characters', quantity: Math.max(1, text.length) };
  let cost = computeUsageCost(product, usage, inferInput, 0);
  if (cost > 0) {
    const now = new Date();
    const licenses = await LicenseKey.find({ buyer: req.user._id, product: product._id, status: 'active' }).sort({ expiresAt: -1 }).limit(5).lean();
    if (licenses.find((l) => licenseCoversProduct(l, product._id) && effectiveLicenseStatus(l, now) === 'active')) cost = 0;
  }
  const selfUse = String(req.user._id) === String(product.creator);
  if (cost > 0 && !selfUse) {
    const { available } = await getAvailableBalance(req.user._id);
    if (available < cost) return res.status(402).json({ message: `Insufficient available wallet balance (need ${cost.toFixed(4)}).`, cost, available });
  }
  const started = Date.now();
  let audio;
  try {
    audio = await aimxTts.synth({ text, lang, voice, sampleBuffer, speed: inferInput?.speed, pitch: inferInput?.pitch });
  } catch (e) {
    return res.status(e.status || 502).json({ message: scrubVendor(e.message) });
  }
  let charged = 0; let sellerNet = 0; let platformFee = 0;
  if (cost > 0 && !selfUse) {
    const billed = await chargeUsage({ buyerId: req.user._id, sellerId: product.creator, product, cost, note: `Playground: ${product.name}` });
    ({ charged, sellerNet, platformFee } = billed);
  }
  const event = await UsageEvent.create({
    deployment: null, product: product._id, buyer: req.user._id, seller: product.creator, inputTokens: 0, outputTokens: 0,
    cost: charged, platformFee, sellerNet, provider: 'aimx_gpu', unit: 'characters', quantity: usage.quantity, rawUsage: usage,
    source: 'playground', usageType: 'VOICE_TTS',
  });
  putVoiceAudio(event._id, audio.buffer, audio.contentType);
  return res.json({
    ok: true, id: event._id.toString(), status: 'COMPLETED', provider: 'AI Markets GPU', model: audio.model, endpointId: '',
    delayTime: 0, executionTime: Date.now() - started,
    output: { kind: 'audio', format: 'wav', text, audio_url: voiceAudioPublicUrl(req, event._id), timings: audio.timings, cost: charged },
    usage, cost: charged, providerCost: 0, platformFee, sellerNet, currency: 'USD',
  });
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
