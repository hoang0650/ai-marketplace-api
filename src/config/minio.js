const crypto = require('crypto');
const Minio = require('minio');

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanPrefix(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/^\/+|\/+$/g, '') || fallback;
}

/**
 * AI Markets runs its own MinIO: S3 API + public objects on cdn.aimarkets.vn,
 * web console on minio.aimarkets.vn. PHHotel's MinIO (*.phhotel.vn) is never used.
 */
const DEFAULT_ENDPOINT = 'https://cdn.aimarkets.vn';
const DEFAULT_PUBLIC_URL = 'https://cdn.aimarkets.vn';
const DEFAULT_BUCKET = 'aimarkets';
const OWN_MEDIA_HOSTS = ['cdn.aimarkets.vn', 'minio.aimarkets.vn'];
const PHHOTEL_HOST_RE = /(^|\.)phhotel\.vn$/i;

function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isPhhotelUrl(value) {
  return PHHOTEL_HOST_RE.test(hostOf(value));
}

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[minio] ${message}`);
}

/** Plain `MINIO_*` names pointing at *.phhotel.vn belong to PHHotel's MinIO — ignore all of them. */
function sharedEnvIsPhhotel() {
  return ['MINIO_ENDPOINT', 'MINIO_PUBLIC_URL', 'MINIO_SERVER_URL'].some((k) => isPhhotelUrl(process.env[k]));
}

/**
 * `AIMARKETS_MINIO_*` first, then the plain `MINIO_*` names (unless those are PHHotel's).
 */
function minioEnv(name, ...fallbacks) {
  const own = String(process.env[`AIMARKETS_${name}`] || '').trim();
  if (own) return own;
  if (sharedEnvIsPhhotel()) {
    warnOnce('Ignoring MINIO_* (points at phhotel.vn); set AIMARKETS_MINIO_* for the AI Markets MinIO.');
    return '';
  }
  for (const key of [name, ...fallbacks]) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function ownUrl(name, fallback) {
  const value = minioEnv(name);
  if (!value) return fallback;
  if (isPhhotelUrl(value)) {
    warnOnce(`${name} points at phhotel.vn; using ${fallback} (AI Markets MinIO).`);
    return fallback;
  }
  return value;
}

function isMinioEnabled() {
  const accessKey = minioEnv('MINIO_ACCESS_KEY', 'MINIO_ROOT_USER');
  const secretKey = minioEnv('MINIO_SECRET_KEY', 'MINIO_ROOT_PASSWORD');
  return Boolean(accessKey && secretKey);
}

function parseEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('MINIO_ENDPOINT is required');
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 9000;
  return {
    endPoint: url.hostname,
    port,
    useSSL: url.protocol === 'https:',
  };
}

function getMinioConfig() {
  const endpoint = parseEndpoint(ownUrl('MINIO_ENDPOINT', DEFAULT_ENDPOINT));
  return {
    ...endpoint,
    accessKey: minioEnv('MINIO_ACCESS_KEY', 'MINIO_ROOT_USER'),
    secretKey: minioEnv('MINIO_SECRET_KEY', 'MINIO_ROOT_PASSWORD'),
    bucket: minioEnv('MINIO_BUCKET') || DEFAULT_BUCKET,
    publicBaseUrl: trimSlash(ownUrl('MINIO_PUBLIC_URL', DEFAULT_PUBLIC_URL)),
    region: minioEnv('MINIO_REGION') || 'us-east-1',
    playgroundPrefix: cleanPrefix(minioEnv('MINIO_PLAYGROUND_PREFIX'), 'aimarkets/playground'),
    voicePrefix: cleanPrefix(minioEnv('MINIO_VOICE_PREFIX'), 'aimarkets/voices'),
    contentPrefix: cleanPrefix(minioEnv('MINIO_CONTENT_PREFIX'), 'aimarkets/content'),
    kycPrefix: cleanPrefix(minioEnv('MINIO_KYC_PREFIX'), 'aimarkets/kyc'),
    trainingPrefix: cleanPrefix(minioEnv('MINIO_TRAINING_PREFIX'), 'aimarkets/training'),
    attachmentPrefix: cleanPrefix(minioEnv('MINIO_ATTACHMENT_PREFIX'), 'aimarkets/attachments'),
  };
}

let client;
let bucketReadyPromise;

function getMinioClient() {
  if (!isMinioEnabled()) throw new Error('MinIO is not configured');
  if (!client) {
    const cfg = getMinioConfig();
    client = new Minio.Client({
      endPoint: cfg.endPoint,
      port: cfg.port,
      useSSL: cfg.useSSL,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
    });
  }
  return client;
}

async function ensurePlaygroundBucket() {
  if (bucketReadyPromise) return bucketReadyPromise;

  bucketReadyPromise = (async () => {
    const cfg = getMinioConfig();
    const minio = getMinioClient();
    const exists = await minio.bucketExists(cfg.bucket).catch(() => false);
    if (!exists) {
      await minio.makeBucket(cfg.bucket, cfg.region);
    }

    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [
            `arn:aws:s3:::${cfg.bucket}/${cfg.playgroundPrefix}/*`,
            `arn:aws:s3:::${cfg.bucket}/${cfg.voicePrefix}/*`,
          ],
        },
      ],
    };
    await minio.setBucketPolicy(cfg.bucket, JSON.stringify(policy)).catch(() => {
      /* policy may already exist or be managed externally */
    });
    return cfg;
  })().catch((error) => {
    bucketReadyPromise = null;
    throw error;
  });

  return bucketReadyPromise;
}

function buildPublicObjectUrl(objectName) {
  const cfg = getMinioConfig();
  const key = String(objectName || '').replace(/^\/+/, '');
  return `${cfg.publicBaseUrl}/${cfg.bucket}/${key}`;
}

function extForMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'image/gif': 'gif',
  };
  return map[String(mime || '').toLowerCase()] || 'bin';
}

async function uploadPlaygroundImageBuffer(buffer, { filename, contentType = 'image/jpeg' } = {}) {
  return uploadPublicBuffer(buffer, {
    filename,
    contentType,
    prefix: (await ensurePlaygroundBucket()).playgroundPrefix,
  });
}

async function uploadVoiceSampleBuffer(buffer, { filename, contentType = 'audio/mpeg' } = {}) {
  const cfg = await ensurePlaygroundBucket();
  return uploadPublicBuffer(buffer, {
    filename,
    contentType,
    prefix: cfg.voicePrefix,
  });
}

async function uploadContentBuffer(buffer, { filename, contentType = 'application/octet-stream' } = {}) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  const ext = extForMime(contentType);
  const objectName = `${cfg.contentPrefix}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await minio.putObject(cfg.bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
  });
  return {
    bucket: cfg.bucket,
    objectName,
    filename: String(filename || objectName),
  };
}

async function getContentObjectStream(objectName) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  return minio.getObject(cfg.bucket, objectName);
}

/**
 * Private KYC ID documents — never public. Stored under aimarkets/kyc/{userId}/…
 */
async function uploadKycBuffer(buffer, { userId, side, filename, contentType = 'image/jpeg' } = {}) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  const ext = extForMime(contentType);
  const uid = String(userId || '')
    .trim()
    .replace(/[^\w\-]+/g, '');
  if (!uid) throw new Error('userId required for KYC upload');
  const safeSide = ['front', 'back', 'license', 'pit-commitment'].includes(String(side || '')) ? String(side) : 'doc';
  const objectName = `${cfg.kycPrefix}/${uid}/${safeSide}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  await minio.putObject(cfg.bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType || 'image/jpeg',
    'Cache-Control': 'private, no-store',
    'x-amz-meta-kyc-side': safeSide,
    'x-amz-meta-user-id': uid,
  });
  return {
    bucket: cfg.bucket,
    objectName,
    filename: String(filename || objectName),
    side: safeSide,
  };
}

function isKycObjectForUser(objectName, userId) {
  const cfg = getMinioConfig();
  const key = String(objectName || '').replace(/^\/+/, '');
  const uid = String(userId || '').trim();
  if (!key || !uid) return false;
  return key.startsWith(`${cfg.kycPrefix}/${uid}/`);
}

async function getKycObjectStream(objectName) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  return minio.getObject(cfg.bucket, objectName);
}

async function getKycPresignedUrl(objectName, expirySeconds = 900) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  return minio.presignedGetObject(cfg.bucket, objectName, expirySeconds);
}

/**
 * Private training data under aimarkets/training/{userId}/… (dataset files + job bundles).
 * Never public: browsers upload and GPU pods download through presigned URLs only.
 */
function trainingObjectName(userId, ...parts) {
  const uid = String(userId || '').replace(/[^\w-]+/g, '');
  if (!uid) throw new Error('userId required for training objects');
  const rest = parts.map((p) => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return [getMinioConfig().trainingPrefix, uid, ...rest].join('/');
}

function isTrainingObjectForUser(objectName, userId) {
  const uid = String(userId || '').trim();
  const key = String(objectName || '').replace(/^\/+/, '');
  if (!uid || !key || key.includes('..')) return false;
  return key.startsWith(`${getMinioConfig().trainingPrefix}/${uid}/`);
}

async function presignTrainingPut(objectName, expirySeconds = 3600) {
  const cfg = await ensurePlaygroundBucket();
  return getMinioClient().presignedPutObject(cfg.bucket, objectName, expirySeconds);
}

/** MinIO caps presigned links at 7 days. */
async function presignTrainingGet(objectName, expirySeconds = 7 * 24 * 3600) {
  const cfg = await ensurePlaygroundBucket();
  return getMinioClient().presignedGetObject(cfg.bucket, objectName, Math.min(expirySeconds, 7 * 24 * 3600));
}

async function statTrainingObject(objectName) {
  const cfg = await ensurePlaygroundBucket();
  try {
    const st = await getMinioClient().statObject(cfg.bucket, objectName);
    return { size: Number(st.size) || 0, contentType: st.metaData?.['content-type'] || '' };
  } catch (err) {
    if (err && (err.code === 'NotFound' || err.code === 'NoSuchKey')) return null;
    throw err;
  }
}

async function putTrainingObject(objectName, buffer, contentType = 'application/octet-stream') {
  const cfg = await ensurePlaygroundBucket();
  await getMinioClient().putObject(cfg.bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
  });
  return objectName;
}

async function removeTrainingObjects(objectNames) {
  const keys = (objectNames || []).filter(Boolean);
  if (!keys.length || !isMinioEnabled()) return;
  const cfg = await ensurePlaygroundBucket();
  await getMinioClient().removeObjects(cfg.bucket, keys);
}

async function uploadPublicBuffer(buffer, { filename, contentType, prefix }) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  const ext = extForMime(contentType);
  const safeName =
    String(filename || `file-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`).replace(
      /[^\w.\-]+/g,
      '_',
    );
  const objectName = `${prefix}/${safeName}`;

  await minio.putObject(cfg.bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  return {
    bucket: cfg.bucket,
    objectName,
    filename: safeName,
    url: buildPublicObjectUrl(objectName),
  };
}

/** Hostnames that serve AI Markets media (defaults + configured public URL). */
function mediaHosts() {
  const hosts = new Set(OWN_MEDIA_HOSTS);
  const publicHost = hostOf(getMinioConfig().publicBaseUrl);
  if (publicHost) hosts.add(publicHost);
  return hosts;
}

/** Size/content type of a private KYC object (null if missing). */
async function statKycObject(objectName) {
  return statTrainingObject(objectName);
}

/** Private chat / workspace attachments under aimarkets/attachments/{scope}/{scopeId}/… (never public). */
async function putAttachmentObject(scope, scopeId, ext, buffer, contentType) {
  const cfg = await ensurePlaygroundBucket();
  const objectName = `${cfg.attachmentPrefix}/${scope}/${String(scopeId).replace(/[^\w-]+/g, '')}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await getMinioClient().putObject(cfg.bucket, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
  });
  return objectName;
}

async function getAttachmentStream(objectName) {
  const cfg = await ensurePlaygroundBucket();
  return getMinioClient().getObject(cfg.bucket, objectName);
}

module.exports = {
  putAttachmentObject,
  getAttachmentStream,
  statKycObject,
  DEFAULT_ENDPOINT,
  DEFAULT_PUBLIC_URL,
  DEFAULT_BUCKET,
  minioEnv,
  mediaHosts,
  isPhhotelUrl,
  isMinioEnabled,
  getMinioConfig,
  getMinioClient,
  ensurePlaygroundBucket,
  uploadPlaygroundImageBuffer,
  uploadVoiceSampleBuffer,
  uploadContentBuffer,
  getContentObjectStream,
  uploadKycBuffer,
  isKycObjectForUser,
  getKycObjectStream,
  getKycPresignedUrl,
  trainingObjectName,
  isTrainingObjectForUser,
  presignTrainingPut,
  presignTrainingGet,
  statTrainingObject,
  putTrainingObject,
  removeTrainingObjects,
  buildPublicObjectUrl,
  extForMime,
};
