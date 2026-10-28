const mongoose = require('mongoose');

const { Schema } = mongoose;

/** One generated take of a shot. Files live in MinIO (aimarkets/film/{user}/{project}/…). */
const versionSchema = new Schema({
  v: { type: Number, required: true },
  videoKey: { type: String, default: '' },
  frameKey: { type: String, default: '' },
  startKey: { type: String, default: '' },
  prompt: { type: String, default: '', maxlength: 1500 },
  seed: { type: Number, default: -1 },
  seconds: { type: Number, default: 0 },
  job: { type: Schema.Types.ObjectId, ref: 'StudioJob', default: null },
  note: { type: String, default: '', maxlength: 200 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const shotSchema = new Schema({
  sid: { type: String, required: true },
  prompt: { type: String, default: '', maxlength: 400 },
  duration: { type: Number, min: 1, max: 60, default: 5 },
  seed: { type: Number, default: -1 },
  status: { type: String, enum: ['draft', 'generating', 'ready', 'failed'], default: 'draft' },
  error: { type: String, default: '' },
  active: { type: Number, default: -1 }, // index into versions
  versions: { type: [versionSchema], default: [] },
}, { _id: false });

const sceneSchema = new Schema({
  sid: { type: String, required: true },
  title: { type: String, default: '', maxlength: 120 },
  prompt: { type: String, default: '', maxlength: 600 },
  narration: { type: String, default: '', maxlength: 1500 },
  voice: { type: String, default: 'Binh', maxlength: 80 },
  lang: { type: String, default: '', maxlength: 8 }, // '' = project language
  camera: { type: String, default: 'push-in', maxlength: 20 },
  transition: { type: String, default: 'cut', maxlength: 20 },
  duration: { type: Number, default: 15, min: 5, max: 60 },
  videoModel: { type: String, default: 'wan-2-2-i2v-720', maxlength: 100 },
  imageModel: { type: String, default: 'qwen-image-edit-2511', maxlength: 100 },
  source: { type: String, enum: ['ai', 'upload'], default: 'ai' },
  uploadId: { type: String, default: '' },      // source=upload: the clip
  startUploadId: { type: String, default: '' }, // ai: optional image to start from
  chainPrev: { type: Boolean, default: false }, // ai: start from the previous scene's last frame
  characterIds: { type: [Schema.Types.ObjectId], default: [] },
  settingId: { type: Schema.Types.ObjectId, default: null },
  status: { type: String, enum: ['draft', 'generating', 'ready', 'partial', 'failed', 'stale'], default: 'draft' },
  error: { type: String, default: '' },
  keyframes: { type: [versionSchema], default: [] },
  generation: { type: Number, default: 0 },
  shots: { type: [shotSchema], default: [] },
}, { _id: false });

const uploadSchema = new Schema({
  uid: { type: String, required: true },
  kind: { type: String, enum: ['video', 'image', 'audio'], required: true },
  name: { type: String, default: '', maxlength: 160 },
  key: { type: String, required: true },
  size: { type: Number, default: 0 },
  contentType: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'ready'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const renderSchema = new Schema({
  job: { type: Schema.Types.ObjectId, ref: 'StudioJob' },
  key: { type: String, default: '' },
  status: { type: String, default: 'queued' },
  duration: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const filmProjectSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: 'Phim AI', maxlength: 120 },
  lang: { type: String, default: 'vi', maxlength: 8 },
  subtitles: { type: String, enum: ['off', 'soft', 'burn'], default: 'off' },
  scenes: { type: [sceneSchema], default: [] },
  uploads: { type: [uploadSchema], default: [] },
  music: { uploadId: { type: String, default: '' }, volume: { type: Number, default: 0.25, min: 0, max: 1 } },
  renders: { type: [renderSchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });

module.exports = mongoose.models.FilmProject || mongoose.model('FilmProject', filmProjectSchema);
