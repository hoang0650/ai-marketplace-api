/**
 * "Giọng sàn" — platform voice listings sold by AI Markets Models (PLATFORM_DIRECT).
 * Vietnamese runs on VieNeu-TTS; every other language runs on Chatterbox multilingual
 * (VieNeu presets are cloned cross-lingually from their reference clip by the AI service).
 */
const { VIENEU_PRESET_VOICES } = require('./vieneu-voices');

/** Chatterbox multilingual languages (ai-marketplace-ai film_lang.LANGS minus vi). */
const CHATTERBOX_LANGS = ['en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'hi', 'ms', 'nl', 'pl', 'tr', 'sv', 'da', 'fi', 'no', 'el', 'he', 'sw'];
const VIENEU_LANGS = ['vi', ...CHATTERBOX_LANGS];

/**
 * USD per 1,000 characters = measured worker cost × 1.32.
 * Basis: 2026-10-26 narration batch, 6,071 chars → $0.0562 RunPod (cold starts included) ≈ $0.0093/1K.
 */
const PLATFORM_VOICE_RATE_PER_1K = 0.0123;
const PLATFORM_VOICE_LICENSE_PRICES = { day: 0.99, month: 4.9, year: 39 };

const LICENSE_VIENEU =
  'VieNeu-TTS (pnnbao-ump/VieNeu-TTS) — Apache-2.0. Lưu ý: dữ liệu huấn luyện gốc có phần CC-BY-NC-4.0 / Note: part of the upstream training data is CC-BY-NC-4.0 / 注：部分上游训练数据为 CC-BY-NC-4.0。 Non-vi languages: Chatterbox multilingual (MIT).';
const LICENSE_CHATTERBOX = 'Chatterbox multilingual (ResembleAI/chatterbox) — MIT.';

const REGION = { Bắc: { en: 'Northern', zh: '北部' }, Nam: { en: 'Southern', zh: '南部' } };
const GENDER = { male: { vi: 'nam', en: 'male', zh: '男声' }, female: { vi: 'nữ', en: 'female', zh: '女声' } };

function vieneuDescription(v) {
  const g = GENDER[v.gender];
  return [
    `**Tiếng Việt** — Giọng sàn ${v.name} (${g.vi}, giọng ${v.region}) do AI Markets vận hành. Tiếng Việt chạy trên VieNeu-TTS; 23 ngôn ngữ khác dùng Chatterbox multilingual nhân bản giọng ${v.name}. Trả theo ký tự, hoặc mua license ngày/tháng/năm để dùng TTS không tính phí ký tự.`,
    '',
    `**English** — ${v.name}, a ${REGION[v.region].en} Vietnamese ${g.en} platform voice run by AI Markets. Vietnamese uses VieNeu-TTS; 23 other languages use Chatterbox multilingual cloning ${v.name}'s timbre. Pay per character, or buy a day/month/year license for unmetered TTS.`,
    '',
    `**中文** — ${v.name}：AI Markets 平台音色（越南${REGION[v.region].zh}口音，${g.zh}）。越南语使用 VieNeu-TTS；其他 23 种语言由 Chatterbox multilingual 克隆该音色。按字符计费，或购买日/月/年授权不限字符使用 TTS。`,
  ].join('\n');
}

const CHATTERBOX_DESCRIPTION = [
  '**Tiếng Việt** — Giọng mặc định của Chatterbox multilingual cho 23 ngôn ngữ (Anh, Trung, Nhật, Hàn, Pháp, Đức, Tây Ban Nha…). Không hỗ trợ tiếng Việt — dùng giọng VieNeu cho tiếng Việt. Trả theo ký tự hoặc license ngày/tháng/năm.',
  '',
  "**English** — Chatterbox multilingual's built-in voice for 23 languages (English, Chinese, Japanese, Korean, French, German, Spanish…). Vietnamese is not included — use a VieNeu voice for Vietnamese. Pay per character or buy a day/month/year license.",
  '',
  '**中文** — Chatterbox multilingual 默认音色，支持 23 种语言（英语、中文、日语、韩语、法语、德语、西班牙语等）。不含越南语，越南语请选用 VieNeu 音色。按字符计费，或购买日/月/年授权。',
].join('\n');

function apiDocs(voiceId, langs) {
  return [
    `Playground / API input: \`{ "prompt": "…", "language": "${langs[0]}" }\` — voice \`${voiceId}\` is fixed by this listing.`,
    '',
    `Languages: ${langs.join(', ')}.`,
    `Price: $${PLATFORM_VOICE_RATE_PER_1K} / 1,000 characters, or an active day / month / year license (TTS included).`,
  ].join('\n');
}

/** Listing definitions; `sampleText`/`sampleLang` drive the demo clip generated through the worker. */
function platformVoiceDefs() {
  const vieneu = VIENEU_PRESET_VOICES.map((v) => ({
    slug: `giong-san-${v.slug}`,
    name: `Giọng sàn · ${v.name}`,
    tagline: `VieNeu ${v.name} · ${GENDER[v.gender].vi} ${v.region} · vi + 23 ngôn ngữ / ${GENDER[v.gender].en} · 24 languages`,
    description: vieneuDescription(v),
    presetVoiceId: v.id,
    presetVoiceName: v.name,
    voiceEngine: 'vieneu',
    voiceGender: v.gender,
    voiceAccent: v.region,
    voiceLanguages: VIENEU_LANGS,
    baseModel: 'pnnbao-ump/VieNeu-TTS',
    license: LICENSE_VIENEU,
    tags: ['giong-san', 'voice-preset', 'vieneu', 'chatterbox', v.gender, v.region === 'Bắc' ? 'mien-bac' : 'mien-nam', 'vi', 'multilingual'],
    sampleLang: 'vi',
    sampleText: `Xin chào, tôi là ${v.name}, giọng đọc tiếng Việt của AI Markets. Tôi có thể đọc truyện, quảng cáo và lồng tiếng video cho bạn.`,
  }));
  const chatterbox = {
    slug: 'giong-san-chatterbox',
    name: 'Giọng sàn · Chatterbox (mặc định)',
    tagline: 'Chatterbox multilingual · 23 ngôn ngữ / 23 languages / 23 种语言',
    description: CHATTERBOX_DESCRIPTION,
    presetVoiceId: 'default',
    presetVoiceName: 'Chatterbox',
    voiceEngine: 'chatterbox',
    voiceGender: 'female',
    voiceAccent: '',
    voiceLanguages: CHATTERBOX_LANGS,
    baseModel: 'ResembleAI/chatterbox-multilingual',
    license: LICENSE_CHATTERBOX,
    tags: ['giong-san', 'voice-preset', 'chatterbox', 'multilingual', 'en', 'zh', 'ja', 'ko'],
    sampleLang: 'en',
    sampleText: 'Hello, this is the default Chatterbox voice on AI Markets. I can narrate stories, ads and videos in twenty-three languages.',
  };
  return [...vieneu, chatterbox];
}

/** Full product document (minus creator ids and the sample URL, which the seeding script fills in). */
function platformVoiceProduct(def, { voiceSampleUrl = '', coverUrl = '' } = {}) {
  return {
    slug: def.slug,
    name: def.name,
    tagline: def.tagline,
    description: def.description,
    category: 'voice-preset',
    ownershipType: 'PLATFORM_DIRECT',
    infraProvider: 'aimx_gpu',
    provider: 'aimx_gpu',
    productType: 'VOICE',
    taxCategory: 'VOICE',
    license: def.license,
    termsSummary: def.license,
    coverUrl,
    pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: '1K characters', usageRate: PLATFORM_VOICE_RATE_PER_1K },
    runtime: { env: [], skills: ['tts'], baseModel: def.baseModel },
    contentMeta: {
      kind: 'voice',
      voiceSource: 'preset',
      voiceModes: ['tts'],
      voiceSampleUrl,
      presetVoiceId: def.presetVoiceId,
      presetVoiceName: def.presetVoiceName,
      voiceEngine: def.voiceEngine,
      voiceGender: def.voiceGender,
      voiceAccent: def.voiceAccent,
      voiceLanguages: def.voiceLanguages,
      creditUnit: 'character',
      charactersPerCredit: 1000,
      cloneStatus: 'ready',
      cloneProvider: 'aimx_gpu',
      cloneEndpoint: def.baseModel,
      licenseTerm: 'month',
      licensePrices: { ...PLATFORM_VOICE_LICENSE_PRICES },
    },
    tags: def.tags,
    apiDocsMarkdown: apiDocs(def.presetVoiceId, def.voiceLanguages),
    complianceStatus: 'approved',
    published: true,
    moderationStatus: 'active',
  };
}

module.exports = {
  CHATTERBOX_LANGS,
  VIENEU_LANGS,
  PLATFORM_VOICE_RATE_PER_1K,
  PLATFORM_VOICE_LICENSE_PRICES,
  platformVoiceDefs,
  platformVoiceProduct,
};
