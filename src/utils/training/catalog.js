/**
 * Training sources and recipes.
 *  raw   = datasets prepared by the buyer (JSONL / CSV / image archives) or a Hugging Face dataset id.
 *  video = real-world footage of people performing (martial arts, dance, exercise…);
 *          pods extract body pose per frame and train on the keypoint sequences.
 *  audio = voice recordings: each clip carries a transcript (speech recognition) or a label
 *          (speaker / command / emotion classification).
 */

const SOURCES = ['raw', 'video', 'audio'];

const TASKS = {
  raw: ['llm-sft', 'image-classification', 'tabular', 'custom'],
  video: ['action-recognition', 'motion-scoring', 'custom'],
  audio: ['speech-recognition', 'audio-classification', 'custom'],
};

const RAW_EXTS = ['jsonl', 'json', 'csv', 'tsv', 'parquet', 'txt', 'zip', 'tar', 'gz', 'tgz'];
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];
const AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'webm'];

const SOURCE_EXTS = { raw: RAW_EXTS, video: VIDEO_EXTS, audio: AUDIO_EXTS };

/** File extensions each recipe can read (custom accepts everything the source allows). */
const TASK_EXTS = {
  'llm-sft': ['jsonl', 'json', 'csv', 'parquet', 'txt'],
  'image-classification': ['zip', 'tar', 'gz', 'tgz'],
  tabular: ['csv', 'tsv', 'parquet'],
  'action-recognition': VIDEO_EXTS,
  'motion-scoring': VIDEO_EXTS,
  'speech-recognition': AUDIO_EXTS,
  'audio-classification': AUDIO_EXTS,
};

/** Default base models when the buyer leaves the field empty. */
const DEFAULT_MODELS = {
  'speech-recognition': 'openai/whisper-small',
  'audio-classification': 'facebook/wav2vec2-base',
};

const TRANSCRIPT_MAX = 2000;

/** Recipes that can pull their data from a Hugging Face dataset instead of uploads. */
const HF_TASKS = new Set(['llm-sft', 'image-classification', 'custom']);

const ROLES = ['sample', 'reference'];

const HF_ID_RE = /^[A-Za-z0-9][\w.-]{0,95}(\/[A-Za-z0-9][\w.-]{0,95})?$/;
const LABEL_RE = /^[\p{L}\p{N} _.-]{1,60}$/u;

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && v > 0 ? v : fallback;
}

function limits() {
  return {
    rawFileMaxBytes: num('TRAINING_RAW_FILE_MAX_MB', 2048) * 1024 * 1024,
    videoFileMaxBytes: num('TRAINING_VIDEO_FILE_MAX_MB', 1024) * 1024 * 1024,
    audioFileMaxBytes: num('TRAINING_AUDIO_FILE_MAX_MB', 200) * 1024 * 1024,
    datasetMaxBytes: num('TRAINING_DATASET_MAX_GB', 20) * 1024 * 1024 * 1024,
    maxFiles: Math.round(num('TRAINING_MAX_FILES', 500)),
    maxDatasets: Math.round(num('TRAINING_MAX_DATASETS', 50)),
  };
}

function httpError(status, code, details) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

function safeFilename(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || 'file';
  const clean = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-120);
  return clean || 'file';
}

function cleanLabel(label) {
  const v = String(label || '').trim().replace(/\s+/g, ' ');
  if (!v) return '';
  if (!LABEL_RE.test(v)) throw httpError(400, 'LABEL_INVALID');
  return v;
}

function cleanTranscript(text) {
  const v = String(text || '').replace(/\s+/g, ' ').trim();
  if (v.length > TRANSCRIPT_MAX) throw httpError(400, 'TRANSCRIPT_TOO_LONG', { max: TRANSCRIPT_MAX });
  return v;
}

function fileMaxBytes(source) {
  const lim = limits();
  if (source === 'video') return lim.videoFileMaxBytes;
  if (source === 'audio') return lim.audioFileMaxBytes;
  return lim.rawFileMaxBytes;
}

function isSource(source) {
  return SOURCES.includes(source);
}

function isTask(source, task) {
  return Boolean(TASKS[source] && TASKS[source].includes(task));
}

/** Validates one upload request against the dataset source and size limits. */
function checkUpload(source, { filename, size }) {
  const ext = extOf(filename);
  const allowed = SOURCE_EXTS[source] || RAW_EXTS;
  if (!allowed.includes(ext)) throw httpError(400, 'FILE_TYPE_NOT_ALLOWED', { allowed });
  const max = fileMaxBytes(source);
  const bytes = Number(size) || 0;
  if (bytes <= 0) throw httpError(400, 'FILE_SIZE_REQUIRED');
  if (bytes > max) throw httpError(413, 'FILE_TOO_LARGE', { maxMb: Math.round(max / 1024 / 1024) });
  return { ext, bytes };
}

function clamp(value, min, max, fallback) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Recipe knobs with safe ranges; unknown keys are dropped. */
function sanitizeConfig(task, raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  switch (task) {
    case 'llm-sft':
      return {
        epochs: Math.round(clamp(c.epochs, 1, 20, 2)),
        learningRate: clamp(c.learningRate, 1e-6, 1e-2, 2e-4),
        loraRank: Math.round(clamp(c.loraRank, 4, 128, 16)),
        maxSeqLength: Math.round(clamp(c.maxSeqLength, 128, 8192, 1024)),
        batchSize: Math.round(clamp(c.batchSize, 1, 64, 4)),
      };
    case 'image-classification':
      return {
        epochs: Math.round(clamp(c.epochs, 1, 200, 10)),
        learningRate: clamp(c.learningRate, 1e-6, 1e-1, 1e-3),
        imageSize: Math.round(clamp(c.imageSize, 64, 512, 224)),
        batchSize: Math.round(clamp(c.batchSize, 1, 256, 32)),
      };
    case 'tabular':
      return {
        target: String(c.target || '').trim().slice(0, 120),
        taskType: ['classification', 'regression'].includes(c.taskType) ? c.taskType : 'auto',
      };
    case 'action-recognition':
      return {
        epochs: Math.round(clamp(c.epochs, 5, 500, 60)),
        learningRate: clamp(c.learningRate, 1e-5, 1e-1, 1e-3),
        windowSec: clamp(c.windowSec, 0.5, 10, 2),
        strideSec: clamp(c.strideSec, 0.1, 5, 0.5),
        fps: Math.round(clamp(c.fps, 10, 60, 30)),
        mirror: c.mirror !== false,
      };
    case 'motion-scoring':
      return {
        fps: Math.round(clamp(c.fps, 5, 30, 15)),
      };
    case 'speech-recognition':
      return {
        epochs: Math.round(clamp(c.epochs, 1, 50, 5)),
        learningRate: clamp(c.learningRate, 1e-7, 1e-3, 1e-5),
        batchSize: Math.round(clamp(c.batchSize, 1, 64, 8)),
        language: /^[a-z]{2,3}$/.test(String(c.language || '').trim().toLowerCase())
          ? String(c.language).trim().toLowerCase()
          : 'vi',
      };
    case 'audio-classification':
      return {
        epochs: Math.round(clamp(c.epochs, 1, 200, 20)),
        learningRate: clamp(c.learningRate, 1e-6, 1e-2, 3e-5),
        batchSize: Math.round(clamp(c.batchSize, 1, 128, 16)),
        maxSeconds: clamp(c.maxSeconds, 1, 30, 10),
      };
    default:
      return {};
  }
}

/**
 * Checks that a dataset can feed the chosen recipe. Returns the files the pod should download.
 * `dataset` may be null for raw jobs that only use a Hugging Face dataset.
 */
function planJob({ source, task, dataset, hfDataset, modelId }) {
  if (!isSource(source)) throw httpError(400, 'TRAINING_SOURCE_INVALID');
  if (!isTask(source, task)) throw httpError(400, 'TRAINING_TASK_INVALID', { allowed: TASKS[source] });
  if (dataset && dataset.source !== source) throw httpError(400, 'DATASET_SOURCE_MISMATCH');

  const hf = String(hfDataset || dataset?.hfDataset || '').trim();
  if (hf && (source !== 'raw' || !HF_TASKS.has(task))) throw httpError(400, 'HF_DATASET_NOT_SUPPORTED');
  if (hf && !HF_ID_RE.test(hf)) throw httpError(400, 'HF_DATASET_INVALID');

  const ready = (dataset?.files || []).filter((f) => f.status === 'ready');
  const exts = TASK_EXTS[task];
  let files = exts ? ready.filter((f) => exts.includes(extOf(f.filename))) : ready;
  if (!files.length && !hf) {
    throw httpError(400, ready.length ? 'DATASET_FILES_MISMATCH' : 'DATASET_EMPTY', exts ? { accepted: exts } : undefined);
  }

  const usesModel = task === 'llm-sft' || Boolean(DEFAULT_MODELS[task]);
  const model = usesModel ? String(modelId || '').trim() || DEFAULT_MODELS[task] || '' : '';
  if (task === 'llm-sft' && !model) throw httpError(400, 'BASE_MODEL_REQUIRED');
  if (model && !HF_ID_RE.test(model)) throw httpError(400, 'BASE_MODEL_INVALID');

  if (task === 'speech-recognition') {
    // Untranscribed clips cannot teach recognition; they stay in the dataset but are not shipped.
    files = files.filter((f) => f.transcript);
    if (!files.length) throw httpError(400, 'TRANSCRIPTS_REQUIRED');
  }

  if (task === 'action-recognition' || task === 'audio-classification') {
    const labels = new Set(files.map((f) => f.label).filter(Boolean));
    if (labels.size < 2) throw httpError(400, 'LABELS_REQUIRED', { minLabels: 2 });
    if (files.some((f) => !f.label)) throw httpError(400, source === 'audio' ? 'AUDIO_LABEL_MISSING' : 'VIDEO_LABEL_MISSING');
  }
  if (task === 'motion-scoring' && !files.some((f) => f.role === 'reference')) {
    throw httpError(400, 'REFERENCE_REQUIRED');
  }

  return { files, hfDataset: hf, modelId: model };
}

module.exports = {
  SOURCES,
  TASKS,
  TASK_EXTS,
  RAW_EXTS,
  VIDEO_EXTS,
  AUDIO_EXTS,
  DEFAULT_MODELS,
  TRANSCRIPT_MAX,
  ROLES,
  HF_ID_RE,
  limits,
  fileMaxBytes,
  httpError,
  extOf,
  safeFilename,
  cleanLabel,
  cleanTranscript,
  isSource,
  isTask,
  checkUpload,
  sanitizeConfig,
  planJob,
};
