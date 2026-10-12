const test = require('node:test');
const assert = require('node:assert/strict');

const { matches, WORK_BLOCKED, HIRE_BLOCKED, workDiscontinued } = require('../../src/middleware/discontinued');
const { sellerApprovalGate } = require('../../src/utils/seller-compliance');
const { KYC_SIDES, requiredSides, canSubmit, LICENSE_SIDE } = require('../../src/utils/kyc');

const req = (method, path) => ({ method, path });

test('work board is fully shut down: every endpoint is discontinued', () => {
  for (const [m, path] of [['POST', '/jobs'], ['GET', '/jobs/abc'], ['GET', '/talents'], ['POST', '/applications/1/deliver'], ['GET', '/contracts/mine'], ['GET', '/applications/mine']]) {
    assert.equal(matches(WORK_BLOCKED, req(m, path)), true, `${m} ${path}`);
  }
});

test('hire projects are fully shut down, including existing projects', () => {
  for (const [m, path] of [['POST', '/projects'], ['GET', '/projects'], ['GET', '/projects/x'], ['POST', '/projects/x/approve'], ['POST', '/projects/x/cancel']]) {
    assert.equal(matches(HIRE_BLOCKED, req(m, path)), true, `${m} ${path}`);
  }
});

test('discontinued middleware answers 410', () => {
  let status = 0;
  let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  workDiscontinued(req('POST', '/jobs'), res, () => assert.fail('should not call next'));
  assert.equal(status, 410);
  assert.equal(body.code, 'WORK_DISCONTINUED');
  workDiscontinued(req('GET', '/contracts/mine'), res, () => assert.fail('should not call next'));
  assert.equal(status, 410);
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
