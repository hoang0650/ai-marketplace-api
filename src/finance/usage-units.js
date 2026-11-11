'use strict';

const { toUsd, charCount, normalizeTimeUnit } = require('../utils/usage-pricing');

/**
 * Fixed usage units for seller listings. Free text is not a unit.
 *
 * Rounding (`exact_pro_rata_round6`):
 * the server count is divided by the unit size and multiplied by the rate.
 * The USD charge is half-up to 6 decimal places. A partial unit is billed
 * pro-rata. It is not rounded up to the next whole unit.
 * Token and character counts are integers. When the provider omits token
 * counts, the estimate is ceil(server character count / 4) on the billed
 * text and the provider output, then the same pro-rata rule applies.
 * Client quantity, client duration and client usage objects are ignored.
 *
 * day / week / month / year are access periods. The gateway checks an
 * entitlement and does not meter the call.
 */
const ROUNDING_ID = 'exact_pro_rata_round6';

const ROUNDING = {
  id: ROUNDING_ID,
  summaryEn:
    'Charge = (server count / unit size) × rate, half-up to 6 decimal USD. Partial units are pro-rata, not ceiled. A missing provider token count uses ceil(characters / 4) first. Client-reported quantity is ignored.',
  summaryVi:
    'Tiền = (số đếm trên máy chủ / cỡ đơn vị) × đơn giá, làm tròn nửa lên 6 chữ số thập phân USD. Phần lẻ tính đúng tỷ lệ, không làm tròn lên cả đơn vị. Thiếu token từ nhà cung cấp thì ước lượng ceil(số ký tự / 4) trước. Số lượng do client gửi bị bỏ qua.',
};

const USAGE_UNITS = [
  { code: '1k_characters', labelEn: '1K characters', labelVi: '1K ký tự', dimension: 'characters', unitSize: 1000, kind: 'metered' },
  { code: '1m_characters', labelEn: '1M characters', labelVi: '1M ký tự', dimension: 'characters', unitSize: 1_000_000, kind: 'metered' },
  { code: '1k_tokens', labelEn: '1K tokens', labelVi: '1K token', dimension: 'tokens', unitSize: 1000, kind: 'metered' },
  { code: '1m_tokens', labelEn: '1M tokens', labelVi: '1M token', dimension: 'tokens', unitSize: 1_000_000, kind: 'metered' },
  { code: '1_second', labelEn: '1 second', labelVi: '1 giây', dimension: 'seconds', unitSize: 1, kind: 'metered' },
  { code: '1_minute', labelEn: '1 minute', labelVi: '1 phút', dimension: 'seconds', unitSize: 60, kind: 'metered' },
  { code: '1_hour', labelEn: '1 hour', labelVi: '1 giờ', dimension: 'seconds', unitSize: 3600, kind: 'metered' },
  { code: '1_request', labelEn: '1 request', labelVi: '1 request', dimension: 'requests', unitSize: 1, kind: 'metered' },
  { code: '1_image', labelEn: '1 image', labelVi: '1 ảnh', dimension: 'images', unitSize: 1, kind: 'metered' },
  { code: '1_day', labelEn: '1 day', labelVi: '1 ngày', dimension: 'access_period', period: 'day', unitSize: 1, kind: 'entitlement' },
  { code: '1_week', labelEn: '1 week', labelVi: '1 tuần', dimension: 'access_period', period: 'week', unitSize: 1, kind: 'entitlement' },
  { code: '1_month', labelEn: '1 month', labelVi: '1 tháng', dimension: 'access_period', period: 'month', unitSize: 1, kind: 'entitlement' },
  { code: '1_year', labelEn: '1 year', labelVi: '1 năm', dimension: 'access_period', period: 'year', unitSize: 1, kind: 'entitlement' },
];

const BY_CODE = new Map(USAGE_UNITS.map((u) => [u.code, u]));

const TEXT_CATEGORIES = ['text-to-text', 'api-endpoint', 'inference', 'agent-runtime', 'hire-agent', 'openrouter', 'featherless'];
const IMAGE_CATEGORIES = ['text-to-image', 'image-to-image'];
const VIDEO_CATEGORIES = ['text-to-video', 'image-to-video'];
const VOICE_CATEGORIES = ['voice-clone', 'voice-preset'];
const COMPUTE_CATEGORIES = ['gpu-compute', 'game-server', 'training-service'];
const CONTENT_CATEGORIES = ['ai-film-series', 'story-book', 'skill-pack', 'dataset'];
const ACCESS = ['1_day', '1_week', '1_month', '1_year'];
const REQUEST = ['1_request'];

function allowedUnitCodes(category) {
  const c = String(category || '');
  if (TEXT_CATEGORIES.includes(c)) return ['1k_tokens', '1m_tokens', '1k_characters', '1m_characters', ...REQUEST, ...ACCESS];
  if (IMAGE_CATEGORIES.includes(c)) return ['1_image', ...REQUEST, ...ACCESS];
  if (VIDEO_CATEGORIES.includes(c)) return ['1_second', '1_minute', '1_hour', ...REQUEST, ...ACCESS];
  if (VOICE_CATEGORIES.includes(c)) return ['1k_characters', '1m_characters', '1_second', '1_minute', ...REQUEST, ...ACCESS];
  if (COMPUTE_CATEGORIES.includes(c)) return ['1_second', '1_minute', '1_hour', '1_request'];
  if (CONTENT_CATEGORIES.includes(c)) return [...ACCESS];
  return [];
}

function unitByCode(code) {
  return BY_CODE.get(String(code || '').trim()) || null;
}

function isComputeCategory(category) {
  return COMPUTE_CATEGORIES.includes(String(category || ''));
}

function publicUnit(unit) {
  return {
    code: unit.code,
    labelEn: unit.labelEn,
    labelVi: unit.labelVi,
    dimension: unit.dimension,
    kind: unit.kind,
    unitSize: unit.unitSize,
    period: unit.period || null,
  };
}

function usageUnitCatalog() {
  const allowedByCategory = {};
  for (const id of [
    ...TEXT_CATEGORIES,
    ...IMAGE_CATEGORIES,
    ...VIDEO_CATEGORIES,
    ...VOICE_CATEGORIES,
    ...COMPUTE_CATEGORIES,
    ...CONTENT_CATEGORIES,
  ]) {
    allowedByCategory[id] = allowedUnitCodes(id);
  }
  return {
    rounding: ROUNDING,
    units: USAGE_UNITS.map(publicUnit),
    allowedByCategory,
  };
}

function fold(raw) {
  return String(raw || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Map one existing free-text unit onto the enum when the text and the
 * category agree. Anything else stays needs_review and is not rewritten.
 */
function migrateUsageUnit(raw, category, { charactersPerCredit } = {}) {
  const legacy = String(raw || '');
  const folded = fold(legacy);
  if (!folded) {
    return { status: 'needs_review', usageUnit: legacy, legacy, code: null };
  }
  if (BY_CODE.has(folded.replace(/ /g, '_'))) {
    const code = folded.replace(/ /g, '_');
    return finishMigration(code, category, legacy, charactersPerCredit);
  }
  const code = freeTextCode(folded);
  if (!code) return { status: 'needs_review', usageUnit: legacy, legacy, code: null };
  return finishMigration(code, category, legacy, charactersPerCredit);
}

function finishMigration(code, category, legacy, charactersPerCredit) {
  const unit = BY_CODE.get(code);
  const meta = Number(charactersPerCredit);
  if (unit.dimension === 'characters' && meta > 0 && meta !== unit.unitSize) {
    return { status: 'needs_review', usageUnit: legacy, legacy, code: null, reason: 'CREDIT_SIZE_CONFLICT' };
  }
  if (!allowedUnitCodes(category).includes(code)) {
    return { status: 'needs_review', usageUnit: legacy, legacy, code: null, reason: 'CATEGORY_CANNOT_METER' };
  }
  return { status: 'canonical', usageUnit: code, legacy, code };
}

function freeTextCode(u) {
  if (u === 'tokens' || /^(1\s*m|million)\s+tokens?$/.test(u) || u === 'mtok' || u === 'million tokens') return '1m_tokens';
  if (/^(1\s*k|thousand)\s+tokens?$/.test(u) || u === 'ktok' || u === '1k tokens') return '1k_tokens';
  if (/(^| )token$/.test(u) && !/tokens/.test(u)) return null;
  if (/character|ký tự|ky tu|chars?/.test(u)) {
    if (/1\s*m|million/.test(u)) return '1m_characters';
    if (/1\s*k|thousand/.test(u) || u === 'characters' || u === 'chars' || u === 'ký tự' || u === 'ky tu') return '1k_characters';
    return null;
  }
  if (/^(per\s+)?(image|images|ảnh|anh)$/.test(u) || u === '1 image' || u === '1 ảnh') return '1_image';
  if (/megapixel|pixel/.test(u)) return null;
  if (/^(per\s+)?(request|requests|call|calls)$/.test(u) || u === '1 request') return '1_request';
  if (/^(1\s*)?(week|weeks|tuần|tuan)$/.test(u)) return '1_week';
  if (/^(1\s*)?(month|months|tháng|thang)$/.test(u)) return '1_month';
  if (/^(1\s*)?(year|years|năm|nam)$/.test(u)) return '1_year';
  const time = normalizeTimeUnit(u);
  if (time === 'second') return '1_second';
  if (time === 'minute') return '1_minute';
  if (time === 'hour') return '1_hour';
  return null;
}

function assertUsageListing(category, usageUnit) {
  const code = String(usageUnit || '').trim();
  const unit = unitByCode(code);
  const accepted = allowedUnitCodes(category);
  if (!unit) {
    return {
      message: 'Đơn vị tính phải là một mã cố định. Không nhập tự do.',
      code: 'USAGE_UNIT_INVALID',
      accepted,
    };
  }
  if (!accepted.includes(unit.code)) {
    return {
      message: 'Đơn vị này không đo được trên loại endpoint của sản phẩm.',
      code: 'USAGE_UNIT_NOT_METERABLE',
      accepted,
    };
  }
  return null;
}

function describeUsageUnit(pricing = {}, category) {
  if (pricing.model !== 'usage' && !pricing.usageUnit) return {};
  const stored = String(pricing.usageUnit || '');
  const migration = migrateUsageUnit(stored, category, {
    charactersPerCredit: pricing.charactersPerCredit,
  });
  const unit = migration.status === 'canonical' ? unitByCode(migration.code) : unitByCode(stored);
  return {
    usageUnit: stored,
    usageUnitCode: unit && migration.status === 'canonical' ? unit.code : null,
    usageUnitLabel: unit && migration.status === 'canonical' ? { vi: unit.labelVi, en: unit.labelEn } : null,
    usageDimension: unit && migration.status === 'canonical' ? unit.dimension : null,
    usageBilling: unit && migration.status === 'canonical' ? unit.kind : null,
    usagePeriod: unit && migration.status === 'canonical' ? unit.period || null : null,
    rounding: unit && unit.kind === 'metered' && migration.status === 'canonical' ? ROUNDING_ID : null,
    usageUnitMigration: migration,
  };
}

function finiteNonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function billedText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input.messages)) {
    return input.messages.map((row) => (typeof row === 'string' ? row : String(row?.content || ''))).join('\n');
  }
  if (typeof input.prompt === 'string') return input.prompt;
  if (typeof input.text === 'string') return input.text;
  if (typeof input.input === 'string') return input.input;
  return '';
}

function generatedText(output) {
  if (!output || typeof output !== 'object') return '';
  const values = [output.text, output.output_text, output.choices?.[0]?.message?.content, output.choices?.[0]?.text];
  return String(values.find((value) => typeof value === 'string' && value) || '');
}

function providerSeconds(output, upstreamUsage) {
  const candidates = [
    output?.duration_seconds,
    output?.durationSec,
    output?.billed_seconds,
    upstreamUsage?.duration_seconds,
    upstreamUsage?.billed_seconds,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function countImages(output) {
  if (!output || typeof output !== 'object') return 0;
  if (Array.isArray(output.images)) return output.images.filter(Boolean).length;
  if (Array.isArray(output.data)) {
    const imgs = output.data.filter((row) => row && (row.url || row.b64_json || row.image_url));
    if (imgs.length) return imgs.length;
  }
  if (output.image_url || output.imageUrl) return 1;
  if (output.kind === 'image') return 1;
  return 0;
}

/**
 * Server measurement for one gateway call. `quantity` on the request or on
 * the usage object is never a billed count.
 */
function measureGatewayUsage({ unit, category, input, upstreamUsage, output, elapsedMs } = {}) {
  const def = unitByCode(unit);
  if (!def || def.kind !== 'metered') {
    return { count: 0, inputTokens: 0, outputTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  const upstream = upstreamUsage && typeof upstreamUsage === 'object' ? upstreamUsage : {};
  if (def.dimension === 'characters') {
    return { count: charCount(billedText(input)), inputTokens: 0, outputTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  if (def.dimension === 'tokens') {
    let inputTokens = Math.floor(finiteNonNeg(upstream.input_tokens ?? upstream.prompt_tokens));
    let outputTokens = Math.floor(finiteNonNeg(upstream.output_tokens ?? upstream.completion_tokens));
    let estimated = false;
    if (!inputTokens && !outputTokens) {
      inputTokens = Math.ceil(charCount(billedText(input)) / 4);
      outputTokens = Math.ceil(charCount(generatedText(output)) / 4);
      estimated = inputTokens + outputTokens > 0;
    }
    return {
      count: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      ignoredClientQuantity: true,
      estimated,
    };
  }
  if (def.dimension === 'seconds') {
    const media = providerSeconds(output, upstream);
    const clock = isComputeCategory(category) && Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) >= 0
      ? Number(elapsedMs) / 1000
      : 0;
    return { count: media > 0 ? media : clock, inputTokens: 0, outputTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  if (def.dimension === 'images') {
    return { count: countImages(output), inputTokens: 0, outputTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  return { count: 1, inputTokens: 0, outputTokens: 0, ignoredClientQuantity: true, estimated: false };
}

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function billMeasuredUsage({ unit, rate, currency = 'USD', inputRate, outputRate, measurement } = {}) {
  const def = unitByCode(unit);
  if (!def || def.kind !== 'metered') {
    return { costUsd: 0, quantity: 0, billableUnits: 0, rounding: ROUNDING_ID };
  }
  const measured = measurement || { count: 0, inputTokens: 0, outputTokens: 0 };
  const flat = toUsd(Number(rate) || 0, currency);
  const inRate = toUsd(Number(inputRate) || 0, currency);
  const outRate = toUsd(Number(outputRate) || 0, currency);
  if (def.dimension === 'tokens' && (inRate > 0 || outRate > 0)) {
    const inR = inRate > 0 ? inRate : flat;
    const outR = outRate > 0 ? outRate : flat;
    const cost = ((measured.inputTokens || 0) * inR + (measured.outputTokens || 0) * outR) / def.unitSize;
    return {
      costUsd: round6(cost),
      quantity: measured.count || (measured.inputTokens || 0) + (measured.outputTokens || 0),
      billableUnits: cost / (flat || inR || outR || 1),
      rounding: ROUNDING_ID,
    };
  }
  const billableUnits = (Number(measured.count) || 0) / def.unitSize;
  return {
    costUsd: round6(billableUnits * flat),
    quantity: Number(measured.count) || 0,
    billableUnits,
    rounding: ROUNDING_ID,
  };
}

/**
 * Rewrite one listing's unit when the free text maps cleanly.
 * Anything else is flagged and the original text is left in place.
 */
function applyUsageUnitMigration(product) {
  const pricing = product?.pricing;
  if (!pricing || pricing.model !== 'usage') return { changed: false, status: 'skipped' };
  const result = migrateUsageUnit(pricing.usageUnit, product.category, {
    charactersPerCredit: product.contentMeta?.charactersPerCredit,
  });
  if (result.status === 'canonical') {
    const changed = pricing.usageUnit !== result.usageUnit || pricing.usageUnitStatus !== 'canonical';
    pricing.usageUnitLegacy = result.legacy;
    pricing.usageUnit = result.usageUnit;
    pricing.usageUnitStatus = 'canonical';
    return { changed, status: 'canonical', usageUnit: result.usageUnit };
  }
  const changed = pricing.usageUnitStatus !== 'needs_review';
  pricing.usageUnitLegacy = result.legacy;
  pricing.usageUnitStatus = 'needs_review';
  return { changed, status: 'needs_review', usageUnit: pricing.usageUnit };
}

function accessPeriodEnd(start, period) {
  const d = new Date(start);
  if (period === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (period === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

module.exports = {
  ROUNDING_ID,
  ROUNDING,
  USAGE_UNITS,
  COMPUTE_CATEGORIES,
  usageUnitCatalog,
  unitByCode,
  allowedUnitCodes,
  migrateUsageUnit,
  assertUsageListing,
  describeUsageUnit,
  measureGatewayUsage,
  billMeasuredUsage,
  applyUsageUnitMigration,
  accessPeriodEnd,
  publicUnit,
};
