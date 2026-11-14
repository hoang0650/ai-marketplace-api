'use strict';

const { toUsd, charCount, normalizeTimeUnit } = require('../utils/usage-pricing');

/**
 * Fixed usage units for seller listings. Free text is not a unit.
 *
 * Rounding (`exact_pro_rata_round6`):
 * the server count is divided by the unit size and multiplied by the rate.
 * The USD charge is half-up to 6 decimal places (the wallet unit for usage).
 * A partial unit is billed pro-rata. Seconds, minutes and hours are not
 * rounded up to the next whole unit. 90s at a per-minute rate is 1.5 minutes.
 * Token and character counts are integers. When the provider omits token
 * counts, the estimate is ceil(server character count / 4) on the billed
 * text and the provider output, then the same pro-rata rule applies.
 * Buyer quantity, buyer duration and a usage object on the request are ignored.
 * The seller runtime may report usage on the upstream response (OpenAI `usage`,
 * `usage.report`, or `X-AIM-Usage`). That report is billed only when its unit
 * matches this listing and the quantity is inside SELLER_REPORT_BOUNDS.
 * Cached input tokens are removed from input and billed at cachedInputRate.
 * A non-2xx upstream response is not billed.
 *
 * day / week / month / year are access periods. The gateway checks an
 * entitlement and does not meter the call.
 *
 * GPU/game session ticks are a separate ledger: whole minutes, and the last
 * partial minute rounds up when the session stops. Gateway request duration
 * uses the pro-rata rule above.
 */
const ROUNDING_ID = 'exact_pro_rata_round6';

const ROUNDING = {
  id: ROUNDING_ID,
  summaryEn:
    'Charge = (count / unit size) × rate, half-up to 6 decimal USD. Seconds, minutes and hours are pro-rata, not ceiled. Buyer quantity is ignored. Seller usage.report and OpenAI usage are accepted within bounds. Cached input tokens use cachedInputRate and are not also billed as input. Non-2xx is free.',
  summaryVi:
    'Tiền = (số đếm / cỡ đơn vị) × đơn giá, làm tròn nửa lên 6 chữ số thập phân USD. Giây, phút và giờ tính đúng tỷ lệ, không làm tròn lên cả đơn vị. Số lượng do buyer gửi bị bỏ qua. usage.report của seller và usage kiểu OpenAI được tính trong giới hạn. Token cache tính theo cachedInputRate và không tính thêm vào input. HTTP không phải 2xx thì không tính tiền.',
};

/** Raw counts a seller report may set on one successful call. */
const SELLER_REPORT_BOUNDS = {
  tokens: 2_000_000,
  characters: 2_000_000,
  images: 32,
  requests: 1,
  /** Hard cap. The gateway also caps at max(2 × wall clock, 1 second). */
  seconds: 6 * 3600,
};

const MEASUREMENT = {
  characters:
    'Unicode NFC code points of the request text. Field order: messages[].content joined by newline, else prompt, else text, else input when it is a string.',
  tokens:
    'prompt_tokens or input_tokens, plus completion_tokens or output_tokens. Cached tokens (prompt_tokens_details.cached_tokens, input_tokens_details.cached_tokens, or cache_read_input_tokens) are included in the prompt count by OpenAI-compatible providers: they are subtracted from input and billed at cachedInputRate (or inputRate / usageRate when that rate is omitted). Missing counts use ceil(characters / 4).',
  images:
    'Images in output.images, else output.data rows with url, b64_json or image_url, else one when output.image_url / imageUrl / kind=image is set.',
  requests: '1 per successful (HTTP 2xx) call. Non-2xx, usage.ok=false and usage.billable=false bill 0.',
  seconds:
    'Provider duration_seconds, durationSec or billed_seconds on the output or usage object. gpu-compute, game-server and training-service fall back to the gateway wall clock. Pro-rata: quantity is seconds / 60 for 1_minute and seconds / 3600 for 1_hour.',
  sellerReport:
    'On the upstream response only: usage.report, usage.aim, usage.seller_report, or usage["x-aim-usage"] (the X-AIM-Usage header JSON). { unit, quantity } or, for tokens, { unit, input, output, cached }. Ignored when the dimension differs or the count exceeds the bounds. A quantity-only token report is billed at usageRate.',
};

const USAGE_UNITS = [
  { code: '1k_characters', labelEn: '1K characters', labelVi: '1K ký tự', dimension: 'characters', unitSize: 1000, kind: 'metered' },
  { code: '1m_characters', labelEn: '1M characters', labelVi: '1M ký tự', dimension: 'characters', unitSize: 1_000_000, kind: 'metered' },
  { code: '1_token', labelEn: '1 token', labelVi: '1 token', dimension: 'tokens', unitSize: 1, kind: 'metered' },
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

/** Short names accepted on create/update. Stored value is always the canonical code. Bare "tokens" stays per 1M. */
const UNIT_ALIASES = {
  token: '1_token',
  '1_token': '1_token',
  per_token: '1_token',
  '1k_token': '1k_tokens',
  '1k_tokens': '1k_tokens',
  '1m_token': '1m_tokens',
  '1m_tokens': '1m_tokens',
  '1k_char': '1k_characters',
  '1k_chars': '1k_characters',
  '1k_characters': '1k_characters',
  '1m_char': '1m_characters',
  '1m_chars': '1m_characters',
  '1m_characters': '1m_characters',
  second: '1_second',
  '1_second': '1_second',
  minute: '1_minute',
  '1_minute': '1_minute',
  hour: '1_hour',
  '1_hour': '1_hour',
  request: '1_request',
  '1_request': '1_request',
  image: '1_image',
  '1_image': '1_image',
};

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
  if (TEXT_CATEGORIES.includes(c)) return ['1_token', '1k_tokens', '1m_tokens', '1k_characters', '1m_characters', ...REQUEST, ...ACCESS];
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
    measurement: MEASUREMENT,
    sellerReportBounds: SELLER_REPORT_BOUNDS,
    walletUnitUsd: 0.000001,
    platformCommissionRate: 0.2,
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
  if (/^(per\s+)?(1\s+)?token$/.test(u)) return '1_token';
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

function resolveListedUnit(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (unitByCode(text)) return text;
  const folded = fold(text).replace(/ /g, '_');
  if (unitByCode(folded)) return folded;
  if (UNIT_ALIASES[folded]) return UNIT_ALIASES[folded];
  return null;
}

/**
 * Accept `unit` / `rate` as aliases of `usageUnit` / `usageRate`, and store
 * short names (`token`, `1k_chars`, `minute`, …) as the canonical code.
 * Free text such as "tokens" or "hour" is left unchanged so existing listings
 * keep billing through the legacy path until a canonical code is saved.
 */
function normalizeUsagePricing(pricing = {}) {
  const next = { ...pricing };
  if ((next.usageUnit == null || String(next.usageUnit).trim() === '') && next.unit != null) {
    next.usageUnit = next.unit;
  }
  if ((next.usageRate == null || next.usageRate === '') && next.rate != null && next.rate !== '') {
    next.usageRate = next.rate;
  }
  const code = resolveListedUnit(next.usageUnit);
  if (code) next.usageUnit = code;
  return next;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function describeUsageUnit(pricing = {}, category) {
  if (pricing.model !== 'usage' && !pricing.usageUnit) return {};
  const stored = String(pricing.usageUnit || '');
  const migration = migrateUsageUnit(stored, category, {
    charactersPerCredit: pricing.charactersPerCredit,
  });
  const unit = migration.status === 'canonical' ? unitByCode(migration.code) : unitByCode(stored);
  const canonical = unit && migration.status === 'canonical';
  return {
    usageUnit: stored,
    usageUnitCode: canonical ? unit.code : null,
    usageUnitLabel: canonical ? { vi: unit.labelVi, en: unit.labelEn } : null,
    usageDimension: canonical ? unit.dimension : null,
    usageBilling: canonical ? unit.kind : null,
    usagePeriod: canonical ? unit.period || null : null,
    rounding: unit && unit.kind === 'metered' && canonical ? ROUNDING_ID : null,
    usageUnitMigration: migration,
    meter: canonical
      ? {
          unit: unit.code,
          rate: Number.isFinite(Number(pricing.usageRate)) ? Number(pricing.usageRate) : 0,
          currency: pricing.currency || 'USD',
          inputRate: finiteOrNull(pricing.inputRate),
          outputRate: finiteOrNull(pricing.outputRate),
          cachedInputRate: finiteOrNull(pricing.cachedInputRate),
          minCharge: finiteOrNull(pricing.minCharge),
          rounding: unit.kind === 'metered' ? ROUNDING_ID : null,
        }
      : null,
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

function cachedTokenCount(upstream = {}) {
  if (!upstream || typeof upstream !== 'object') return 0;
  const details = upstream.prompt_tokens_details || upstream.input_tokens_details || {};
  const values = [
    details.cached_tokens,
    details.cachedTokens,
    upstream.cache_read_input_tokens,
    upstream.cacheReadInputTokens,
    upstream.cached_input_tokens,
    upstream.cached_tokens,
    upstream.cachedTokens,
  ];
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/** Non-2xx, or an explicit ok/billable false, is not a charge. */
function isBillableUsage(usage) {
  if (!usage || typeof usage !== 'object') return true;
  if (usage.ok === false || usage.billable === false) return false;
  const http = Number(usage.http_status ?? usage.httpStatus);
  if (Number.isFinite(http) && (http < 200 || http >= 300)) return false;
  return true;
}

function noteUpstreamStatus(usage, source) {
  const row = usage && typeof usage === 'object' ? usage : {};
  if (source && source.ok === false) row.ok = false;
  const candidates = [source?.status, source?.http_status, source?.httpStatus, row.http_status, row.httpStatus];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 100 && n < 600) {
      row.http_status = n;
      break;
    }
  }
  return row;
}

function secondsCap(elapsedMs) {
  const hard = SELLER_REPORT_BOUNDS.seconds;
  if (elapsedMs == null || elapsedMs === '') return hard;
  const wall = Number(elapsedMs);
  if (!Number.isFinite(wall) || wall < 0) return hard;
  return Math.min(hard, Math.max((wall / 1000) * 2, 1));
}

function parseReportValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

function readSellerReport(upstream) {
  if (!upstream || typeof upstream !== 'object') return null;
  return (
    parseReportValue(upstream.report) ||
    parseReportValue(upstream.aim) ||
    parseReportValue(upstream.seller_report) ||
    parseReportValue(upstream['x-aim-usage']) ||
    parseReportValue(upstream.x_aim_usage)
  );
}

function applySellerReport(def, report, elapsedMs) {
  const code = resolveListedUnit(report.unit) || freeTextCode(fold(report.unit));
  const reported = unitByCode(code);
  if (!reported || reported.dimension !== def.dimension) return { ok: false, reason: 'dimension' };
  const split = report.input != null || report.output != null || report.cached != null
    || report.prompt_tokens != null || report.completion_tokens != null
    || report.input_tokens != null || report.output_tokens != null;
  if (def.dimension === 'tokens' && split) {
    const prompt = Math.floor(finiteNonNeg(report.input ?? report.prompt_tokens ?? report.input_tokens));
    const output = Math.floor(finiteNonNeg(report.output ?? report.completion_tokens ?? report.output_tokens));
    let cached = Math.floor(finiteNonNeg(
      report.cached ?? report.cached_tokens ?? report.cache_read_input_tokens
        ?? report.prompt_tokens_details?.cached_tokens
    ));
    if (cached > prompt) cached = prompt;
    const fresh = prompt - cached;
    const total = fresh + cached + output;
    if (total > SELLER_REPORT_BOUNDS.tokens) return { ok: false, reason: 'bounds' };
    if (!(total > 0)) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      measurement: {
        count: total,
        inputTokens: fresh,
        outputTokens: output,
        cachedTokens: cached,
        ignoredClientQuantity: true,
        estimated: false,
        sellerReported: true,
        flatQuantity: false,
      },
    };
  }
  const qty = def.dimension === 'seconds' ? finiteNonNeg(report.quantity) : Math.floor(finiteNonNeg(report.quantity));
  if (!(qty > 0)) return { ok: false, reason: 'empty' };
  const cap = def.dimension === 'seconds'
    ? secondsCap(elapsedMs)
    : SELLER_REPORT_BOUNDS[def.dimension] || 0;
  if (qty > cap) return { ok: false, reason: 'bounds' };
  if (def.dimension === 'tokens') {
    return {
      ok: true,
      measurement: {
        count: qty,
        inputTokens: qty,
        outputTokens: 0,
        cachedTokens: 0,
        ignoredClientQuantity: true,
        estimated: false,
        sellerReported: true,
        flatQuantity: true,
      },
    };
  }
  return {
    ok: true,
    measurement: {
      count: qty,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      ignoredClientQuantity: true,
      estimated: false,
      sellerReported: true,
      flatQuantity: true,
    },
  };
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
  const empty = { count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ignoredClientQuantity: true, estimated: false };
  if (!def || def.kind !== 'metered') return empty;
  const upstream = upstreamUsage && typeof upstreamUsage === 'object' ? upstreamUsage : {};
  if (!isBillableUsage(upstream)) return { ...empty, unbilled: 'http_status' };
  const report = readSellerReport(upstream);
  if (report) {
    const applied = applySellerReport(def, report, elapsedMs);
    if (applied.ok) return applied.measurement;
  }
  if (def.dimension === 'characters') {
    return { count: charCount(billedText(input)), inputTokens: 0, outputTokens: 0, cachedTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  if (def.dimension === 'tokens') {
    let prompt = Math.floor(finiteNonNeg(upstream.input_tokens ?? upstream.prompt_tokens));
    let outputTokens = Math.floor(finiteNonNeg(upstream.output_tokens ?? upstream.completion_tokens));
    let cachedTokens = Math.min(prompt, cachedTokenCount(upstream));
    let estimated = false;
    if (!prompt && !outputTokens) {
      prompt = Math.ceil(charCount(billedText(input)) / 4);
      outputTokens = Math.ceil(charCount(generatedText(output)) / 4);
      cachedTokens = 0;
      estimated = prompt + outputTokens > 0;
    }
    const inputTokens = prompt - cachedTokens;
    return {
      count: inputTokens + cachedTokens + outputTokens,
      inputTokens,
      outputTokens,
      cachedTokens,
      ignoredClientQuantity: true,
      estimated,
    };
  }
  if (def.dimension === 'seconds') {
    const media = providerSeconds(output, upstream);
    const clock = isComputeCategory(category) && Number.isFinite(Number(elapsedMs)) && Number(elapsedMs) >= 0
      ? Number(elapsedMs) / 1000
      : 0;
    return { count: media > 0 ? media : clock, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  if (def.dimension === 'images') {
    return { count: countImages(output), inputTokens: 0, outputTokens: 0, cachedTokens: 0, ignoredClientQuantity: true, estimated: false };
  }
  return { count: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ignoredClientQuantity: true, estimated: false };
}

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function billMeasuredUsage({ unit, rate, currency = 'USD', inputRate, outputRate, cachedInputRate, measurement } = {}) {
  const def = unitByCode(unit);
  if (!def || def.kind !== 'metered') {
    return { costUsd: 0, quantity: 0, billableUnits: 0, rounding: ROUNDING_ID };
  }
  const measured = measurement || { count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const flat = toUsd(Number(rate) || 0, currency);
  const inRate = toUsd(Number(inputRate) || 0, currency);
  const outRate = toUsd(Number(outputRate) || 0, currency);
  const cacheSpecified = cachedInputRate != null && cachedInputRate !== '' && Number.isFinite(Number(cachedInputRate));
  const cacheRate = cacheSpecified ? toUsd(Number(cachedInputRate) || 0, currency) : null;
  const split = def.dimension === 'tokens' && !measured.flatQuantity && (inRate > 0 || outRate > 0 || cacheRate != null);
  if (split) {
    const inR = inRate > 0 ? inRate : flat;
    const outR = outRate > 0 ? outRate : flat;
    const cacheR = cacheRate != null ? cacheRate : inR;
    const fresh = measured.inputTokens || 0;
    const cached = measured.cachedTokens || 0;
    const out = measured.outputTokens || 0;
    const cost = (fresh * inR + cached * cacheR + out * outR) / def.unitSize;
    return {
      costUsd: round6(cost),
      quantity: measured.count || fresh + cached + out,
      billableUnits: cost / (flat || inR || outR || cacheR || 1),
      rounding: ROUNDING_ID,
      cachedTokens: cached,
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

function eventMeter(explanation, usage = {}) {
  const failed = explanation?.unbilled === 'http_status';
  const measured = Boolean(explanation?.measured);
  return {
    unit: (measured && explanation.unit) || usage.unit || explanation?.unit || 'tokens',
    quantity: failed ? 0 : (measured ? Number(explanation.quantity) || 0 : Number(usage.quantity) || Number(explanation?.quantity) || 0),
    rate: explanation?.rate ?? null,
    cachedTokens: Number(explanation?.cachedTokens) || Number(usage.cached_tokens) || 0,
    bill: explanation?.bill || null,
  };
}

module.exports = {
  ROUNDING_ID,
  ROUNDING,
  USAGE_UNITS,
  UNIT_ALIASES,
  SELLER_REPORT_BOUNDS,
  MEASUREMENT,
  COMPUTE_CATEGORIES,
  usageUnitCatalog,
  unitByCode,
  allowedUnitCodes,
  migrateUsageUnit,
  assertUsageListing,
  describeUsageUnit,
  normalizeUsagePricing,
  resolveListedUnit,
  measureGatewayUsage,
  billMeasuredUsage,
  applyUsageUnitMigration,
  accessPeriodEnd,
  publicUnit,
  cachedTokenCount,
  isBillableUsage,
  noteUpstreamStatus,
  eventMeter,
};
