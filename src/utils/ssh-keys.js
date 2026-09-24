/**
 * OpenSSH key generation for SpaceBot sandbox access.
 *
 * SpaceBot's sshd (port 2222) authenticates with public keys only, so we
 * generate an RSA keypair per session: the private key (PKCS#1 PEM, which
 * OpenSSH accepts) is handed to the buyer, and the OpenSSH-format public key
 * is pushed to the instance via `PUT /api/ssh/authorized-key`.
 *
 * Pure Node — no dependency on a system `ssh-keygen`.
 */

const crypto = require('crypto');

/** RFC 4251 `string`: 4-byte big-endian length followed by the bytes. */
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** RFC 4251 `mpint`: minimal two's-complement big-endian, zero-padded if the high bit is set. */
function sshMpint(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  let bytes = buf.subarray(i);
  if (bytes.length && bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return sshString(bytes);
}

/** Encode an RSA JWK as an `ssh-rsa AAAA…` OpenSSH public key line. */
function rsaJwkToOpenssh(jwk, comment = '') {
  const e = Buffer.from(jwk.e, 'base64url');
  const n = Buffer.from(jwk.n, 'base64url');
  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-rsa')),
    sshMpint(e),
    sshMpint(n),
  ]);
  const suffix = comment ? ` ${comment}` : '';
  return `ssh-rsa ${blob.toString('base64')}${suffix}`;
}

/** Base64 SHA-256 fingerprint of the public key blob, e.g. `SHA256:abc…`. */
function sshFingerprint(opensshPublicKey) {
  const parts = String(opensshPublicKey || '').trim().split(/\s+/);
  if (parts.length < 2) return '';
  const digest = crypto.createHash('sha256').update(Buffer.from(parts[1], 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Generate an RSA keypair suitable for OpenSSH.
 * @returns {{ privateKey: string, publicKey: string, fingerprint: string, comment: string }}
 */
function generateSshKeyPair({ comment = '', modulusLength = 3072 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
  const openssh = rsaJwkToOpenssh(jwk, comment);
  return {
    privateKey,
    publicKey: openssh,
    fingerprint: sshFingerprint(openssh),
    comment,
  };
}

module.exports = {
  generateSshKeyPair,
  rsaJwkToOpenssh,
  sshFingerprint,
};
