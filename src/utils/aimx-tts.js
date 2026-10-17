const { gpuConfig, gpuFetch } = require('./aimx-gpu');
const { voiceLang, voiceFx } = require('./voice-params');

const VIENEU_MODEL = 'pnnbao-ump/VieNeu-TTS-v3-Turbo';
const CHATTERBOX_MODEL = 'ResembleAI/chatterbox-multilingual';

function enabled() {
  return gpuConfig().enabled && process.env.PLAYGROUND_TTS_GPU !== 'false';
}

function langOf(input = {}) {
  const l = String(input.language || input.lang || 'vi').toLowerCase().slice(0, 2);
  return voiceLang(l);
}

/** Synthesize on the AI Markets 5090 (VieNeu for vi/en, Chatterbox for zh); waits up to `waitMs`. */
async function synth({ text, lang = 'vi', voice, sampleBuffer, speed, pitch, waitMs = 90000 }) {
  const body = { text: String(text || '').slice(0, 2000), lang, ...voiceFx({ speed, pitch }) };
  if (voice) body.voice = voice;
  if (sampleBuffer) body.voice_base64 = Buffer.from(sampleBuffer).toString('base64');
  const r = await gpuFetch('/v1/tts', { method: 'POST', body: JSON.stringify(body), timeout: 60000 });
  if (!r.ok) throw Object.assign(new Error(`GPU TTS unavailable (${r.status})`), { status: 503 });
  const job = await r.json();
  const until = Date.now() + waitMs;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 700));
    const s = await (await gpuFetch(`/v1/jobs/${job.id}`)).json();
    if (s.status === 'succeeded') {
      const a = await gpuFetch(s.audio_url, { timeout: 60000 });
      return { buffer: Buffer.from(await a.arrayBuffer()), contentType: 'audio/wav', timings: s.timings || {}, model: lang === 'zh' ? CHATTERBOX_MODEL : VIENEU_MODEL };
    }
    if (s.status === 'failed') throw Object.assign(new Error(s.error || 'TTS failed'), { status: 502 });
    if (Date.now() > until) throw Object.assign(new Error('TTS timed out'), { status: 504 });
  }
}

module.exports = { enabled, synth, langOf, VIENEU_MODEL, CHATTERBOX_MODEL };
