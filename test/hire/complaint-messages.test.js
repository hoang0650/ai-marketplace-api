const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Complaint = require('../../src/models/Complaint');
const { mapComplaint } = require('../../src/utils/complaint-helpers');

test('complaint messages store attachments and map with signed links', () => {
  const a = new mongoose.Types.ObjectId();
  const c = new Complaint({ complainant: new mongoose.Types.ObjectId(), kind: 'buyer_seller', body: 'x'.repeat(30) });
  c.messages.push({ author: c.complainant, role: 'complainant', body: 'Bổ sung bằng chứng', attachments: [{ attachment: a, name: 'proof.png', mime: 'image/png', size: 10, kind: 'image' }] });
  const m = mapComplaint(c).messages[0];
  assert.equal(m.role, 'complainant');
  assert.equal(m.attachments[0].name, 'proof.png');
  assert.match(m.attachments[0].url, /sig=/);
  assert.throws(() => { const bad = new Complaint({ complainant: c.complainant, kind: 'buyer_seller' }); bad.messages.push({ author: c.complainant, role: 'hacker' }); const e = bad.validateSync(); if (e) throw e; });
});

test('attachments accept the complaint scope', () => {
  const Attachment = require('../../src/models/Attachment');
  const a = new Attachment({ owner: new mongoose.Types.ObjectId(), scope: 'complaint', scopeId: new mongoose.Types.ObjectId(), objectName: 'x', name: 'a.png', mime: 'image/png', size: 1, kind: 'image' });
  assert.equal(a.validateSync()?.errors?.scope, undefined);
});
