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

function isMinioEnabled() {
  const endpoint = String(process.env.MINIO_ENDPOINT || '').trim();
  const accessKey = String(process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || '').trim();
  const secretKey = String(process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || '').trim();
  return Boolean(endpoint && accessKey && secretKey);
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
  const endpoint = parseEndpoint(process.env.MINIO_ENDPOINT || 'https://minio.phhotel.vn');
  return {
    ...endpoint,
    accessKey: String(process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || '').trim(),
    secretKey: String(process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || '').trim(),
    bucket: String(process.env.MINIO_BUCKET || 'phhotel').trim() || 'phhotel',
    publicBaseUrl: trimSlash(process.env.MINIO_PUBLIC_URL || 'https://minio.phhotel.vn'),
    playgroundPrefix: cleanPrefix(process.env.MINIO_PLAYGROUND_PREFIX, 'aimarkets/playground'),
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
      await minio.makeBucket(cfg.bucket, process.env.MINIO_REGION || 'us-east-1');
    }

    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${cfg.bucket}/${cfg.playgroundPrefix}/*`],
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
  };
  return map[String(mime || '').toLowerCase()] || 'jpg';
}

async function uploadPlaygroundImageBuffer(buffer, { filename, contentType = 'image/jpeg' } = {}) {
  const cfg = await ensurePlaygroundBucket();
  const minio = getMinioClient();
  const ext = extForMime(contentType);
  const safeName =
    String(filename || `playground-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`).replace(
      /[^\w.\-]+/g,
      '_',
    );
  const objectName = `${cfg.playgroundPrefix}/${safeName}`;

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

module.exports = {
  isMinioEnabled,
  getMinioConfig,
  getMinioClient,
  ensurePlaygroundBucket,
  uploadPlaygroundImageBuffer,
  buildPublicObjectUrl,
};
