const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectFile, signedPath, verifySig, publicAttachment, MAX_BYTES } = require('../../src/utils/attachments');
const { isTestRecipient } = require('../../src/email/send');

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
const pdf = Buffer.from('%PDF-1.7\n...');
const zip = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(32)]);

test('allowlisted types pass with matching magic bytes', () => {
  assert.equal(inspectFile(png, 'logo.png').kind, 'image');
  assert.equal(inspectFile(pdf, 'Báo giá.pdf').mime, 'application/pdf');
  assert.equal(inspectFile(zip, 'source.zip').kind, 'file');
  assert.equal(inspectFile(zip, 'brief.docx').ext, 'docx');
  assert.equal(inspectFile(Buffer.from('a,b\n1,2'), 'data.csv').mime, 'text/csv');
});

test('executables, scripts, html/svg and spoofed types are refused', () => {
  const mz = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
  assert.throws(() => inspectFile(mz, 'setup.exe'), /FILE_TYPE_NOT_ALLOWED/);
  assert.throws(() => inspectFile(mz, 'invoice.pdf'), /FILE_TYPE_NOT_ALLOWED/);
  assert.throws(() => inspectFile(Buffer.from('<svg onload=alert(1)>'), 'x.svg'), /FILE_TYPE_NOT_ALLOWED/);
  assert.throws(() => inspectFile(Buffer.from('<script>alert(1)</script>'), 'notes.txt'), /FILE_CONTENT_MISMATCH/);
  assert.throws(() => inspectFile(pdf, 'photo.png'), /FILE_CONTENT_MISMATCH/);
  assert.throws(() => inspectFile(Buffer.from('#!/bin/sh\nrm -rf /'), 'run.txt'), /FILE_TYPE_NOT_ALLOWED/);
  assert.throws(() => inspectFile(Buffer.alloc(MAX_BYTES + 1, 1), 'big.txt'), /FILE_TOO_LARGE/);
});

test('signed links expire and cannot be reused for another id', () => {
  const id = '6ad0a2124114365ec7d29a68';
  const u = new URL(`https://x${signedPath(id, 60)}`);
  assert.ok(verifySig(id, u.searchParams.get('exp'), u.searchParams.get('sig')));
  assert.ok(!verifySig('6ad0a2124114365ec7d29a69', u.searchParams.get('exp'), u.searchParams.get('sig')));
  assert.ok(!verifySig(id, Math.floor(Date.now() / 1000) - 5, u.searchParams.get('sig')));
  const a = publicAttachment({ _id: id, name: 'a.pdf', mime: 'application/pdf', size: 3, kind: 'file' }, 'https://api.example');
  assert.match(a.downloadUrl, /&dl=1$/);
});

test('seed/test recipients never get real mail', () => {
  assert.ok(isTestRecipient('buyer@example.com'));
  assert.ok(isTestRecipient('pulse@creators.dev'));
  assert.ok(!isTestRecipient('someone@gmail.com'));
});
