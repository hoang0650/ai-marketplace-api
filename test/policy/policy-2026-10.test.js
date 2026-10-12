const test = require('node:test');
const assert = require('node:assert/strict');

const { matches, WORK_BLOCKED, HIRE_BLOCKED, workDiscontinued } = require('../../src/middleware/discontinued');
const { sellerApprovalGate } = require('../../src/utils/seller-compliance');
const { KYC_SIDES, requiredSides, canSubmit, LICENSE_SIDE } = require('../../src/utils/kyc');

const req = (method, path) => ({ method, path });

test('work board: new jobs / applications / talent CVs are discontinued, in-flight actions stay', () => {
  assert.equal(matches(WORK_BLOCKED, req('POST', '/jobs')), true);
  assert.equal(matches(WORK_BLOCKED, req('POST', '/jobs/abc/applications')), true);
  assert.equal(matches(WORK_BLOCKED, req('GET', '/talents')), true);
  assert.equal(matches(WORK_BLOCKED, req('PUT', '/talents/me')), true);
  assert.equal(matches(WORK_BLOCKED, req('POST', '/applications/1/deliver')), false);
  assert.equal(matches(WORK_BLOCKED, req('GET', '/contracts/mine')), false);
  assert.equal(matches(WORK_BLOCKED, req('GET', '/jobs/abc')), false);
});

test('hire projects: new requests / quotes / accept are discontinued, delivery actions stay', () => {
  assert.equal(matches(HIRE_BLOCKED, req('POST', '/projects')), true);
  assert.equal(matches(HIRE_BLOCKED, req('POST', '/projects/x/quote')), true);
  assert.equal(matches(HIRE_BLOCKED, req('POST', '/projects/x/accept')), true);
  assert.equal(matches(HIRE_BLOCKED, req('POST', '/projects/x/approve')), false);
  assert.equal(matches(HIRE_BLOCKED, req('POST', '/projects/x/cancel')), false);
  assert.equal(matches(HIRE_BLOCKED, req('GET', '/projects')), false);
});

test('discontinued middleware answers 410', () => {
  let status = 0;
  let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  workDiscontinued(req('POST', '/jobs'), res, () => assert.fail('should not call next'));
  assert.equal(status, 410);
  assert.equal(body.code, 'WORK_DISCONTINUED');
  let nexted = false;
  workDiscontinued(req('GET', '/contracts/mine'), res, () => { nexted = true; });
  assert.equal(nexted, true);
});

test('seller approval requires verified eKYC', () => {
  assert.equal(sellerApprovalGate({ sellerType: 'INDIVIDUAL' }, { status: 'pending' }).code, 'SELLER_KYC_REQUIRED');
  assert.equal(sellerApprovalGate({ sellerType: 'INDIVIDUAL' }, null).code, 'SELLER_KYC_REQUIRED');
  assert.equal(sellerApprovalGate({ sellerType: 'INDIVIDUAL' }, { status: 'verified' }).ok, true);
});

test('household business / company approval requires the business licence', () => {
  const noLicense = { status: 'verified', subjectType: 'organization' };
  assert.equal(sellerApprovalGate({ sellerType: 'HOUSEHOLD_BUSINESS' }, noLicense).code, 'BUSINESS_LICENSE_REQUIRED');
  assert.equal(sellerApprovalGate({ sellerType: 'enterprise' }, noLicense).code, 'BUSINESS_LICENSE_REQUIRED');
  const withLicense = { ...noLicense, licenseObjectName: 'kyc/u1/license.jpg' };
  assert.equal(sellerApprovalGate({ sellerType: 'COMPANY' }, withLicense).ok, true);
});

test('eKYC: organizations must upload the licence, individuals only front/back', () => {
  assert.deepEqual(KYC_SIDES, ['front', 'back']);
  assert.equal(LICENSE_SIDE, 'license');
  assert.deepEqual(requiredSides('individual'), ['front', 'back']);
  assert.deepEqual(requiredSides('organization'), ['front', 'back', 'license']);
  const docs = { frontObjectName: 'a', backObjectName: 'b' };
  assert.equal(canSubmit(docs, 'none', 'individual'), true);
  assert.equal(canSubmit(docs, 'none', 'organization'), false);
  assert.equal(canSubmit({ ...docs, licenseObjectName: 'c' }, 'none', 'organization'), true);
});

const { addBusinessDays } = require('../../src/utils/business-days');
const { complaintDeadlines, appealWindowOpen } = require('../../src/utils/complaint-sla');

test('business days skip the Vietnamese weekend', () => {
  // Friday 2026-10-09 10:00 VN time
  const fri = new Date('2026-10-09T03:00:00Z');
  assert.equal(addBusinessDays(fri, 1).toISOString(), '2026-10-12T03:00:00.000Z');
  assert.equal(addBusinessDays(fri, 7).toISOString(), '2026-10-20T03:00:00.000Z');
});

test('complaint deadlines follow Quy chế 2.1 timelines', () => {
  const d = complaintDeadlines({ createdAt: '2026-10-09T03:00:00Z', decidedAt: '2026-10-20T03:00:00Z' });
  assert.equal(d.acknowledgeBy, '2026-10-10T03:00:00.000Z');
  assert.equal(d.verifyBy, '2026-10-12T03:00:00.000Z');
  assert.equal(d.sellerResponseBy, '2026-10-13T03:00:00.000Z');
  assert.equal(d.decisionBy, '2026-10-20T03:00:00.000Z');
  assert.equal(d.appealBy, '2026-10-27T03:00:00.000Z');
  assert.equal(d.appealAnswerBy, null);
  const decided = { decidedAt: '2026-10-20T03:00:00Z' };
  assert.equal(appealWindowOpen(decided, new Date('2026-10-26T00:00:00Z')), true);
  assert.equal(appealWindowOpen(decided, new Date('2026-10-28T00:00:00Z')), false);
});
