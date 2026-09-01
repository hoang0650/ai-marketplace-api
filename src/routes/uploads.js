const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { isMinioEnabled, uploadPlaygroundImageBuffer } = require('../config/minio');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only jpeg, jpg, png, webp images are allowed'));
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

module.exports = router;
