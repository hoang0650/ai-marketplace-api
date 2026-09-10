const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { isMinioEnabled, uploadPlaygroundImageBuffer, uploadVoiceSampleBuffer } = require('../config/minio');

const router = express.Router();

const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only jpeg, jpg, png, webp images are allowed'));
  },
});

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const mime = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const ok = AUDIO_TYPES.has(mime) || /\.(mp3|wav|m4a|aac|ogg|webm)$/.test(name);
    if (ok) cb(null, true);
    else cb(new Error('Only mp3, wav, m4a, ogg voice samples are allowed'));
  },
});

/** POST /v1/uploads/image — playground reference image → MinIO public URL */
router.post('/image', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    if (!isMinioEnabled()) {
      return res.status(503).json({
        message: 'Image upload is not configured (MinIO)',
        code: 'MINIO_NOT_CONFIGURED',
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No image file uploaded', code: 'NO_FILE' });
    }

    const uploaded = await uploadPlaygroundImageBuffer(req.file.buffer, {
      contentType: req.file.mimetype,
      filename: req.file.originalname,
    });

    res.status(201).json({
      ok: true,
      url: uploaded.url,
      objectName: uploaded.objectName,
      bucket: uploaded.bucket,
      filename: uploaded.filename,
    });
  } catch (e) {
    if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Image must be 16MB or smaller', code: 'FILE_TOO_LARGE' });
    }
    next(e);
  }
});

/** POST /v1/uploads/audio — seller voice sample MP3 → MinIO public URL */
router.post('/audio', authenticate, uploadAudio.single('audio'), async (req, res, next) => {
  try {
    if (!isMinioEnabled()) {
      return res.status(503).json({
        message: 'Audio upload is not configured (MinIO)',
        code: 'MINIO_NOT_CONFIGURED',
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file uploaded', code: 'NO_FILE' });
    }

    const mime = String(req.file.mimetype || 'audio/mpeg').toLowerCase();
    const contentType = AUDIO_TYPES.has(mime) ? mime : 'audio/mpeg';
    const uploaded = await uploadVoiceSampleBuffer(req.file.buffer, {
      contentType,
      filename: req.file.originalname,
    });

    res.status(201).json({
      ok: true,
      url: uploaded.url,
      objectName: uploaded.objectName,
      bucket: uploaded.bucket,
      filename: uploaded.filename,
      contentType,
    });
  } catch (e) {
    if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Voice sample must be 20MB or smaller', code: 'FILE_TOO_LARGE' });
    }
    next(e);
  }
});

module.exports = router;
