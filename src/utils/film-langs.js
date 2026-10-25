/**
 * AI Film narration languages (mirror of ai-marketplace-ai film_lang.py; the AI service validates again).
 * vi -> VieNeu-TTS (6 presets); the 23 Chatterbox Multilingual languages -> Chatterbox with its built-in
 * "default" voice or the same 6 named voices as cross-lingual clones. Billing is per character for all.
 */
const { LANGS } = require('./voice-params');

const NAMES = {
  vi: 'Tiếng Việt', en: 'English', zh: '中文', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español',
  it: 'Italiano', pt: 'Português', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी', ms: 'Bahasa Melayu', nl: 'Nederlands',
  pl: 'Polski', tr: 'Türkçe', sv: 'Svenska', da: 'Dansk', fi: 'Suomi', no: 'Norsk', el: 'Ελληνικά', he: 'עברית', sw: 'Kiswahili',
};
const FONTS = { zh: 'Noto Sans CJK SC', ja: 'Noto Sans CJK JP', ko: 'Noto Sans CJK KR', ar: 'Noto Sans Arabic', he: 'Noto Sans Hebrew', hi: 'Noto Sans Devanagari' };
const PRESETS = [
  { id: 'Binh', name: 'Bình', gender: 'male', region: 'bac' },
  { id: 'Tuyen', name: 'Tuyên', gender: 'male', region: 'bac' },
  { id: 'Ly', name: 'Ly', gender: 'female', region: 'bac' },
  { id: 'Ngoc', name: 'Ngọc', gender: 'female', region: 'bac' },
  { id: 'Vinh', name: 'Vĩnh', gender: 'male', region: 'nam' },
  { id: 'Doan', name: 'Đoan', gender: 'female', region: 'nam' },
];
const SUBTITLES = ['off', 'soft', 'burn'];

/** '' when not a supported film language (scene override "inherit"). */
function filmLang(v) {
  let l = String(v || '').trim().toLowerCase().replace('_', '-').split('-')[0];
  if (l === 'nb' || l === 'nn') l = 'no';
  return LANGS.includes(l) ? l : '';
}

function voicesFor(lang) {
  const l = filmLang(lang) || 'vi';
  const kind = l === 'vi' ? 'preset' : 'clone';
  const list = PRESETS.map((v) => ({ ...v, kind }));
  return l === 'vi' ? list : [{ id: 'default', name: 'Chatterbox', gender: 'female', kind: 'builtin' }, ...list];
}
const defaultVoice = (lang) => ((filmLang(lang) || 'vi') === 'vi' ? 'Binh' : 'default');
const validVoice = (lang, voice) => voicesFor(lang).some((v) => v.id === voice);

/** Effective {lang, voice} of a scene: scene override, else project language; voice falls back per language. */
function sceneVoice(p, s) {
  const lang = filmLang(s && s.lang) || filmLang(p && p.lang) || 'vi';
  const voice = s && validVoice(lang, s.voice) ? s.voice : defaultVoice(lang);
  return { lang, voice };
}

function catalog() {
  return {
    languages: LANGS.map((code) => ({
      code, name: NAMES[code], engine: code === 'vi' ? 'vieneu' : 'chatterbox', font: FONTS[code] || 'Noto Sans',
      rtl: code === 'ar' || code === 'he', defaultVoice: defaultVoice(code),
    })),
    voices: Object.fromEntries(LANGS.map((c) => [c, voicesFor(c)])),
    subtitles: SUBTITLES,
  };
}

const subtitleMode = (v) => (SUBTITLES.includes(String(v)) ? String(v) : 'off');

module.exports = { filmLang, voicesFor, defaultVoice, validVoice, sceneVoice, catalog, subtitleMode, SUBTITLES };
