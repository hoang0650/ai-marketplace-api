const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const catalog = require('../../src/utils/training/catalog');
const bundle = require('../../src/utils/training/bundle');
const minio = require('../../src/config/minio');
const svc = require('../../src/utils/gpu-rental/service');
const TrainingJob = require('../../src/models/TrainingJob');
const { jobStatus, applyReport, tokenMatches, volumeFor } = require('../../src/routes/training-jobs');

const saved = [];
function stub(obj, key, fn) {
  saved.push([obj, key, obj[key]]);
  obj[key] = fn;
}
afterEach(() => {
  while (saved.length) {
    const [obj, key, orig] = saved.pop();
    obj[key] = orig;
  }
});

function file(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    objectName: 'aimarkets/training/u/datasets/d/x',
    filename: 'clip.mp4',
    size: 1000,
    label: '',
    role: 'sample',
    status: 'ready',
    ...over,
  };
}

function videoSet(files) {
  return { source: 'video', files, hfDataset: '' };
}

describe('training catalog', () => {
  test('raw and video sources expose separate recipes', () => {
    assert.ok(catalog.isTask('raw', 'llm-sft'));
    assert.ok(catalog.isTask('video', 'action-recognition'));
    assert.ok(!catalog.isTask('raw', 'motion-scoring'));
    assert.ok(!catalog.isTask('video', 'tabular'));
  });

  test('uploads are checked against the dataset source and size caps', () => {
    assert.equal(catalog.checkUpload('video', { filename: 'kata.MOV', size: 10 }).ext, 'mov');
    assert.throws(() => catalog.checkUpload('video', { filename: 'data.csv', size: 10 }), { code: 'FILE_TYPE_NOT_ALLOWED' });
    assert.throws(() => catalog.checkUpload('raw', { filename: 'clip.mp4', size: 10 }), { code: 'FILE_TYPE_NOT_ALLOWED' });
    assert.throws(() => catalog.checkUpload('raw', { filename: 'a.jsonl', size: 0 }), { code: 'FILE_SIZE_REQUIRED' });
    assert.throws(() => catalog.checkUpload('video', { filename: 'a.mp4', size: 5 * 1024 ** 4 }), { code: 'FILE_TOO_LARGE' });
  });

  test('labels allow Vietnamese text but no markup', () => {
    assert.equal(catalog.cleanLabel('  Đấm   thẳng '), 'Đấm thẳng');
    assert.throws(() => catalog.cleanLabel('<script>'), { code: 'LABEL_INVALID' });
  });

  test('action recognition needs two labelled moves', () => {
    const one = videoSet([file({ label: 'Đấm' }), file({ label: 'Đấm' })]);
    assert.throws(() => catalog.planJob({ source: 'video', task: 'action-recognition', dataset: one }), { code: 'LABELS_REQUIRED' });
    const unlabeled = videoSet([file({ label: 'Đấm' }), file({ label: 'Đá' }), file({ label: '' })]);
    assert.throws(() => catalog.planJob({ source: 'video', task: 'action-recognition', dataset: unlabeled }), {
      code: 'VIDEO_LABEL_MISSING',
    });
    const ok = videoSet([file({ label: 'Đấm' }), file({ label: 'Đá' }), file({ label: 'Đá', status: 'pending' })]);
    assert.equal(catalog.planJob({ source: 'video', task: 'action-recognition', dataset: ok }).files.length, 2);
  });

  test('motion scoring needs a reference performance', () => {
    const noRef = videoSet([file(), file()]);
    assert.throws(() => catalog.planJob({ source: 'video', task: 'motion-scoring', dataset: noRef }), { code: 'REFERENCE_REQUIRED' });
    const ok = videoSet([file({ role: 'reference' }), file()]);
    assert.equal(catalog.planJob({ source: 'video', task: 'motion-scoring', dataset: ok }).files.length, 2);
  });

  test('raw recipes check formats, base model and Hugging Face ids', () => {
    const csv = { source: 'raw', files: [file({ filename: 'a.csv' })] };
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'image-classification', dataset: csv }), {
      code: 'DATASET_FILES_MISMATCH',
    });
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'llm-sft', dataset: csv }), { code: 'BASE_MODEL_REQUIRED' });
    assert.equal(
      catalog.planJob({ source: 'raw', task: 'llm-sft', hfDataset: 'org/chat-vi', modelId: 'Qwen/Qwen2.5-0.5B-Instruct' }).hfDataset,
      'org/chat-vi'
    );
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'tabular', hfDataset: 'org/x' }), { code: 'HF_DATASET_NOT_SUPPORTED' });
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'custom', hfDataset: '../../etc' }), { code: 'HF_DATASET_INVALID' });
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'custom' }), { code: 'DATASET_EMPTY' });
  });

  test('voice clips have their own formats and size cap', () => {
    assert.ok(catalog.isTask('audio', 'speech-recognition'));
    assert.ok(!catalog.isTask('audio', 'action-recognition'));
    assert.equal(catalog.checkUpload('audio', { filename: 'ghi âm.M4A', size: 10 }).ext, 'm4a');
    assert.throws(() => catalog.checkUpload('audio', { filename: 'clip.mp4', size: 10 }), { code: 'FILE_TYPE_NOT_ALLOWED' });
    assert.throws(() => catalog.checkUpload('audio', { filename: 'a.wav', size: catalog.fileMaxBytes('audio') + 1 }), {
      code: 'FILE_TOO_LARGE',
    });
    assert.equal(catalog.cleanTranscript('  xin   chào\n quý khách '), 'xin chào quý khách');
    assert.throws(() => catalog.cleanTranscript('a'.repeat(2001)), { code: 'TRANSCRIPT_TOO_LONG' });
  });

  test('speech recognition ships only transcribed clips with a Whisper default', () => {
    const wav = (over) => file({ filename: 'a.wav', ...over });
    const none = { source: 'audio', files: [wav(), wav()] };
    assert.throws(() => catalog.planJob({ source: 'audio', task: 'speech-recognition', dataset: none }), {
      code: 'TRANSCRIPTS_REQUIRED',
    });
    const some = { source: 'audio', files: [wav({ transcript: 'xin chào' }), wav()] };
    const plan = catalog.planJob({ source: 'audio', task: 'speech-recognition', dataset: some });
    assert.equal(plan.files.length, 1);
    assert.equal(plan.modelId, 'openai/whisper-small');
    assert.equal(
      catalog.planJob({ source: 'audio', task: 'speech-recognition', dataset: some, modelId: 'vinai/PhoWhisper-small' }).modelId,
      'vinai/PhoWhisper-small'
    );
  });

  test('audio classification needs every clip labelled', () => {
    const wav = (label) => file({ filename: 'a.wav', label });
    const missing = { source: 'audio', files: [wav('Hoàng'), wav('Lan'), wav('')] };
    assert.throws(() => catalog.planJob({ source: 'audio', task: 'audio-classification', dataset: missing }), {
      code: 'AUDIO_LABEL_MISSING',
    });
    const ok = { source: 'audio', files: [wav('Hoàng'), wav('Lan')] };
    assert.equal(catalog.planJob({ source: 'audio', task: 'audio-classification', dataset: ok }).modelId, 'facebook/wav2vec2-base');
    assert.equal(catalog.sanitizeConfig('speech-recognition', { language: 'EN' }).language, 'en');
    assert.equal(catalog.sanitizeConfig('speech-recognition', { language: 'en;rm' }).language, 'vi');
  });

  test('dataset must match the chosen source', () => {
    assert.throws(() => catalog.planJob({ source: 'raw', task: 'custom', dataset: videoSet([file()]) }), {
      code: 'DATASET_SOURCE_MISMATCH',
    });
  });

  test('recipe config is clamped and unknown keys dropped', () => {
    const c = catalog.sanitizeConfig('action-recognition', { epochs: 9999, windowSec: 0.01, mirror: false, rm: 'x' });
    assert.equal(c.epochs, 500);
    assert.equal(c.windowSec, 0.5);
    assert.equal(c.mirror, false);
    assert.equal(c.rm, undefined);
    assert.deepEqual(catalog.sanitizeConfig('custom', { a: 1 }), {});
  });
});

describe('training job bundle', () => {
  test('video files land in per-label folders, references apart', () => {
    const f = file({ filename: 'Bài 1 (thầy).mp4', label: 'Hổ trảo', role: 'reference' });
    assert.match(bundle.podPath('video', f), /^videos\/_reference\/[a-f0-9]{6}-B/);
    assert.match(bundle.podPath('video', file({ label: 'Hổ trảo' })), /^videos\/Hổ_trảo\//);
    assert.match(bundle.podPath('raw', file({ filename: 'chat.jsonl' })), /^raw\/[a-f0-9]{6}-chat\.jsonl$/);
    assert.match(bundle.podPath('audio', file({ filename: 'a.wav', label: 'Hoàng' })), /^audio\/Hoàng\/[a-f0-9]{6}-a\.wav$/);
    assert.deepEqual(bundle.recipeFiles('audio', 'custom'), ['bootstrap.py', 'audio_utils.py']);
  });

  test('every task has its scripts on disk', () => {
    for (const source of catalog.SOURCES) {
      for (const task of catalog.TASKS[source]) {
        for (const name of bundle.recipeFiles(source, task)) {
          assert.ok(fs.existsSync(path.join(bundle.RECIPES_DIR, name)), `${task}: ${name}`);
        }
        if (task !== 'custom') assert.ok(bundle.TASK_ENTRY[task], task);
      }
    }
  });

  test('manifest carries presigned links but never the job token', async () => {
    const puts = {};
    stub(minio, 'trainingObjectName', (uid, ...parts) => ['aimarkets/training', uid, ...parts].join('/'));
    stub(minio, 'putTrainingObject', async (key, buf) => {
      puts[key] = buf.toString();
      return key;
    });
    stub(minio, 'presignTrainingGet', async (key) => `https://cdn.aimarkets.vn/signed/${key}`);
    const out = await bundle.buildJobBundle({
      userId: 'u1',
      jobId: 'tj_1',
      source: 'video',
      task: 'motion-scoring',
      files: [file({ role: 'reference' }), file({ label: 'Học viên' })],
      config: { fps: 15 },
      labels: ['Học viên'],
    });
    const manifest = JSON.parse(puts['aimarkets/training/u1/jobs/tj_1/manifest.json']);
    assert.equal(manifest.entry, 'motion_scoring.py');
    assert.deepEqual(
      manifest.recipes.map((r) => r.name),
      ['bootstrap.py', 'pose_features.py', 'motion_scoring.py', 'score_motion.py']
    );
    assert.equal(manifest.files.length, 2);
    assert.match(manifest.api.report, /\/v1\/training-jobs\/tj_1\/report$/);
    assert.doesNotMatch(JSON.stringify(manifest), /AIM_JOB_TOKEN|reportTokenHash/);
    assert.match(out.bootstrapUrl, /recipes\/bootstrap\.py$/);
    assert.equal(out.objects.length, 5);
  });

  test('job tokens are compared by hash', () => {
    const { token, hash } = bundle.newJobToken();
    assert.ok(tokenMatches(token, hash));
    assert.ok(!tokenMatches(`${token}x`, hash));
    assert.ok(!tokenMatches('', hash));
  });

  test('workspace volume grows with the dataset', () => {
    assert.equal(volumeFor([{ size: 1 }], 0), 20);
    assert.equal(volumeFor([{ size: 30 * 1024 ** 3 }], 0), 85);
    assert.equal(volumeFor([{ size: 500 * 1024 ** 3 }], 0), 200);
  });
});

describe('training pod start command', () => {
  test('training pods save job credentials and run the bootstrap in the background', () => {
    const cmd = svc.buildDockerArgs('abc', { training: true });
    assert.match(cmd, /AIM_TRAINING_BOOTSTRAP_URL/);
    assert.match(cmd, /chmod 600 \/workspace\/aim\/job\.env/);
    assert.match(cmd, /nohup python3 \/workspace\/aim\/bootstrap\.py/);
    assert.match(cmd, /unset AIM_TRAINING_BOOTSTRAP_URL AIM_TRAINING_MANIFEST_URL AIM_JOB_TOKEN/);
    assert.match(cmd, /exec jupyter lab/);
    assert.doesNotMatch(cmd, /'[^']*'[^']*'/, 'no nested single quotes inside bash -c');
  });

  test('plain GPU rentals do not run the bootstrap', () => {
    const cmd = svc.buildDockerArgs('abc');
    assert.doesNotMatch(cmd, /bootstrap\.py/);
    assert.match(cmd, /unset AIM_TRAINING_BOOTSTRAP_URL/);
  });
});

describe('training progress reports', () => {
  function job(over = {}) {
    return new TrainingJob({ jobId: 'tj_x', buyer: new mongoose.Types.ObjectId(), status: 'queued', ...over });
  }

  test('pod reports move the job forward and finish it', () => {
    const doc = job();
    assert.equal(applyReport(doc, { status: 'running', stage: 'pose!!', progress: 140, metrics: { valAccuracy: 0.9 } }), false);
    assert.equal(doc.status, 'running');
    assert.equal(doc.stage, 'pose');
    assert.equal(doc.progress, 100);
    assert.equal(doc.metrics.valAccuracy, 0.9);
    assert.equal(applyReport(doc, { status: 'succeeded' }), true);
    assert.equal(doc.status, 'succeeded');
    assert.ok(doc.finishedAt);
  });

  test('logs keep the tail and oversized metrics are ignored', () => {
    const doc = job({ metrics: { a: 1 } });
    applyReport(doc, { logs: 'x'.repeat(20_000) + 'END', metrics: { big: 'y'.repeat(9_000) } });
    assert.equal(doc.logs.length, 16_000);
    assert.ok(doc.logs.endsWith('END'));
    assert.deepEqual(doc.metrics, { a: 1 });
  });

  test('finished results are not overwritten by the workspace state', () => {
    assert.equal(jobStatus({ status: 'stopped', stoppedReason: 'job_done' }, 'succeeded'), 'succeeded');
    assert.equal(jobStatus({ status: 'running' }, 'failed'), 'failed');
    assert.equal(jobStatus({ status: 'stopped' }, 'running'), 'paused');
  });
});
