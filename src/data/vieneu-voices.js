/** VieNeu-TTS-v3-Turbo preset roster (SDK ≥ 3.3.0) — keep in sync with denglish/tts_vieneu.py */
const VIENEU_PRESET_VOICES = [
  { id: 'adam', name: 'Adam', region: 'Nam', character: 'Natural', gender: 'male' },
  { id: 'pham-tuyen', name: 'Phạm Tuyên', region: 'Bắc', character: 'Natural', gender: 'male' },
  { id: 'minh-duc', name: 'Minh Đức', region: 'Bắc', character: 'News', gender: 'male' },
  { id: 'thanh-binh', name: 'Thanh Bình', region: 'Bắc', character: 'Storytelling', gender: 'male' },
  { id: 'ngoc-huyen', name: 'Ngọc Huyền', region: 'Bắc', character: 'Natural', gender: 'female' },
  { id: 'truc-ly', name: 'Trúc Ly', region: 'Bắc', character: 'Natural', gender: 'female' },
  { id: 'doan-trang', name: 'Đoan Trang', region: 'Bắc', character: 'Natural', gender: 'female' },
  { id: 'ngoc-linh', name: 'Ngọc Linh', region: 'Bắc', character: 'Storytelling', gender: 'female' },
  { id: 'mai-anh', name: 'Mai Anh', region: 'Bắc', character: 'News', gender: 'female' },
  { id: 'quynh-anh', name: 'Quỳnh Anh', region: 'Bắc', character: 'Audiobook', gender: 'female' },
  { id: 'quang-son', name: 'Quang Sơn', region: 'Trung', character: 'Natural', gender: 'male' },
  { id: 'ngoc-tran', name: 'Ngọc Trân', region: 'Trung', character: 'Natural', gender: 'female' },
  { id: 'xuan-vinh', name: 'Xuân Vĩnh', region: 'Nam', character: 'Natural', gender: 'male' },
  { id: 'thai-son', name: 'Thái Sơn', region: 'Nam', character: 'Storytelling', gender: 'male' },
  { id: 'minh-triet', name: 'Minh Triết', region: 'Nam', character: 'News', gender: 'male' },
  { id: 'duc-tri', name: 'Đức Trí', region: 'Nam', character: 'Audiobook', gender: 'male' },
  { id: 'thuc-doan', name: 'Thục Đoan', region: 'Nam', character: 'Storytelling', gender: 'female' },
  { id: 'thuy-dung', name: 'Thùy Dung', region: 'Nam', character: 'News', gender: 'female' },
  { id: 'my-duyen', name: 'Mỹ Duyên', region: 'Nam', character: 'Audiobook', gender: 'female' },
  { id: 'kim-thanh', name: 'Kim Thanh', region: 'Nam', character: 'Audiobook', gender: 'female' },
];

function findPresetVoice(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return VIENEU_PRESET_VOICES.find((v) => v.id === key || v.name.toLowerCase() === key) || null;
}

module.exports = { VIENEU_PRESET_VOICES, findPresetVoice };
