/** Voice controls passed through to the AI service (which post-processes with ffmpeg rubberband). */
const LANGS = ['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'hi', 'ms', 'nl', 'pl', 'tr', 'sv', 'da', 'fi', 'no', 'el', 'he', 'sw'];
const PRESETS = new Set(['tram', 'tu-nhien', 'cao']);

function voiceLang(v, d = 'vi') {
  const l = String(v || '').toLowerCase().split('-')[0].slice(0, 3);
  return LANGS.includes(l) ? l : d;
}

/** { speed?, pitch? } only when set; the AI service clamps again (speed 0.5-2, pitch -12..12 semitones or preset). */
function voiceFx(b = {}) {
  const out = {};
  const s = Number(b.speed);
  if (b.speed != null && b.speed !== '' && Number.isFinite(s)) out.speed = Math.min(2, Math.max(0.5, Math.round(s * 100) / 100));
  if (typeof b.pitch === 'string' && PRESETS.has(b.pitch)) out.pitch = b.pitch;
  else if (b.pitch != null && b.pitch !== '' && Number.isFinite(Number(b.pitch))) out.pitch = Math.min(12, Math.max(-12, Math.round(Number(b.pitch) * 2) / 2));
  if (out.speed === 1) delete out.speed;
  if (out.pitch === 0) delete out.pitch;
  return out;
}

module.exports = { LANGS, voiceLang, voiceFx };
