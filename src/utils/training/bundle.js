const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const minio = require('../../config/minio');
const { safeFilename } = require('./catalog');

const RECIPES_DIR = path.join(__dirname, 'recipes');

/** Entry script per task; `custom` only downloads data and leaves training to the buyer. */
const TASK_ENTRY = {
  'llm-sft': 'llm_sft.py',
  'image-classification': 'image_classification.py',
  tabular: 'tabular.py',
  'action-recognition': 'action_recognition.py',
  'motion-scoring': 'motion_scoring.py',
  'speech-recognition': 'speech_recognition.py',
  'audio-classification': 'audio_classification.py',
  custom: '',
};

const TASK_FILES = {
  'llm-sft': ['llm_sft.py'],
  'image-classification': ['image_classification.py'],
  tabular: ['tabular.py'],
  'action-recognition': ['pose_features.py', 'action_recognition.py', 'predict_action.py'],
  'motion-scoring': ['pose_features.py', 'motion_scoring.py', 'score_motion.py'],
  'speech-recognition': ['audio_utils.py', 'speech_recognition.py'],
  'audio-classification': ['audio_utils.py', 'audio_classification.py'],
};

/** Helpers copied for `custom` jobs so buyers start from working loaders. */
const CUSTOM_HELPERS = { video: ['pose_features.py'], audio: ['audio_utils.py'] };

function recipeFiles(source, task) {
  const files = TASK_FILES[task] || CUSTOM_HELPERS[source] || [];
  return ['bootstrap.py', ...files];
}

function readRecipe(name) {
  return fs.readFileSync(path.join(RECIPES_DIR, name));
}

function apiBase() {
  const raw =
    process.env.PUBLIC_API_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.AIMARKETS_API_HOST ||
    'https://api.aimarkets.vn';
  return String(raw).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function newJobToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** Where each dataset file lands under /workspace/data on the pod. */
function podPath(source, file) {
  const name = `${String(file._id).slice(-6)}-${safeFilename(file.filename)}`;
  if (source === 'raw') return `raw/${name}`;
  const label = file.label ? file.label.replace(/[^\p{L}\p{N}_.-]+/gu, '_') : '_unlabeled';
  if (source === 'audio') return `audio/${label}/${name}`;
  return `videos/${file.role === 'reference' ? '_reference' : label}/${name}`;
}

/**
 * Uploads the recipe scripts + manifest for one job to private storage and returns the presigned
 * links the pod needs. Dataset links last 7 days (MinIO max); the pod downloads them at first boot.
 */
async function buildJobBundle({ userId, jobId, source, task, files, modelId, hfDataset, config, labels }) {
  const prefix = minio.trainingObjectName(userId, 'jobs', jobId);
  const objects = [];

  const recipes = [];
  for (const name of recipeFiles(source, task)) {
    const key = `${prefix}/recipes/${name}`;
    await minio.putTrainingObject(key, readRecipe(name), 'text/x-python');
    objects.push(key);
    recipes.push({ name, url: await minio.presignTrainingGet(key) });
  }

  const dataFiles = [];
  for (const f of files) {
    dataFiles.push({
      path: podPath(source, f),
      filename: f.filename,
      size: f.size,
      label: f.label || '',
      transcript: f.transcript || '',
      role: f.role || 'sample',
      url: await minio.presignTrainingGet(f.objectName),
    });
  }

  const base = apiBase();
  const manifest = {
    version: 1,
    jobId,
    source,
    task,
    entry: TASK_ENTRY[task] || '',
    modelId: modelId || '',
    hfDataset: hfDataset || '',
    labels: labels || [],
    config: config || {},
    api: {
      base,
      report: `${base}/v1/training-jobs/${jobId}/report`,
      artifactUrl: `${base}/v1/training-jobs/${jobId}/artifact-url`,
    },
    paths: { data: '/workspace/data', output: '/workspace/output', aim: '/workspace/aim' },
    recipes,
    files: dataFiles,
  };
  const manifestKey = `${prefix}/manifest.json`;
  await minio.putTrainingObject(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  objects.push(manifestKey);

  return {
    objects,
    manifestUrl: await minio.presignTrainingGet(manifestKey),
    bootstrapUrl: recipes[0].url,
  };
}

module.exports = {
  RECIPES_DIR,
  TASK_ENTRY,
  recipeFiles,
  apiBase,
  newJobToken,
  hashToken,
  podPath,
  buildJobBundle,
};
