/**
 * Platform voices ("Giọng sàn") — the presets the AI Markets worker actually serves.
 * Keep in sync with denglish/handler.py VIENEU_PRESETS and ai-marketplace-ai/film_lang.py PRESETS.
 * `id` is the worker voice name; `aliases` are retired VieNeu-v3-Turbo names the worker maps onto it.
 */
const VIENEU_PRESET_VOICES = [
  { id: 'Binh', slug: 'binh', name: 'Bình', region: 'Bắc', gender: 'male', aliases: ['thanh-binh', 'thanh bình', 'minh-duc', 'minh đức'] },
  { id: 'Tuyen', slug: 'tuyen', name: 'Tuyên', region: 'Bắc', gender: 'male', aliases: ['pham-tuyen', 'phạm tuyên'] },
  { id: 'Ly', slug: 'ly', name: 'Ly', region: 'Bắc', gender: 'female', aliases: ['truc-ly', 'trúc ly'] },
  { id: 'Ngoc', slug: 'ngoc', name: 'Ngọc', region: 'Bắc', gender: 'female', aliases: ['ngoc-huyen', 'ngọc huyền', 'ngoc-linh', 'ngọc linh'] },
  { id: 'Vinh', slug: 'vinh', name: 'Vĩnh', region: 'Nam', gender: 'male', aliases: ['xuan-vinh', 'xuân vĩnh'] },
  { id: 'Doan', slug: 'doan', name: 'Đoan', region: 'Nam', gender: 'female', aliases: ['doan-trang', 'đoan trang', 'thuc-doan', 'thục đoan'] },
];

function findPresetVoice(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return (
    VIENEU_PRESET_VOICES.find(
      (v) => v.id.toLowerCase() === key || v.slug === key || v.name.toLowerCase() === key || v.aliases.includes(key)
    ) || null
  );
}

module.exports = { VIENEU_PRESET_VOICES, findPresetVoice };
