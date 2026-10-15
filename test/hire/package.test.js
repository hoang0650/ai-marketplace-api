const test = require('node:test');
const assert = require('node:assert/strict');
const { packageMilestones, assertAction, advanceAfterApproval, currentMilestone } = require('../../src/utils/hire/rules');

const now = new Date('2026-10-15T00:00:00Z');

test('package splits fixed price into 30/40/30 phases with increasing deadlines; sums exactly', () => {
  const ms = packageMilestones({ pricing: { price: 8 } }, { now });
  assert.equal(ms.length, 3);
  assert.deepEqual(ms.map((m) => m.amount), [2.4, 3.2, 2.4]);
  assert.equal(Math.round(ms.reduce((a, m) => a + m.amount, 0) * 100), 800);
  assert.equal(ms[0].status, 'in_progress');
  assert.equal(ms[1].status, 'pending');
  assert.ok(ms[0].dueAt < ms[1].dueAt && ms[1].dueAt < ms[2].dueAt);
});

test('rounding remainder lands on the last phase', () => {
  const ms = packageMilestones({ pricing: { price: 10.01 } }, { now });
  assert.equal(Math.round(ms.reduce((a, m) => a + m.amount, 0) * 100), 1001);
});

test('seller servicePlan is used when it sums to 100%', () => {
  const ms = packageMilestones({ pricing: { price: 100 }, servicePlan: [{ title: 'A', percent: 50, days: 3 }, { title: 'B', percent: 50, days: 3 }] }, { now });
  assert.deepEqual(ms.map((m) => [m.title, m.amount]), [['A', 50], ['B', 50]]);
  assert.ok(ms[1].dueAt > ms[0].dueAt);
  const bad = packageMilestones({ pricing: { price: 100 }, servicePlan: [{ title: 'A', percent: 60, days: 3 }] }, { now });
  assert.equal(bad.length, 3);
});

test('tiny packages are one phase; zero price rejected', () => {
  assert.equal(packageMilestones({ pricing: { price: 2 } }, { now }).length, 1);
  assert.throws(() => packageMilestones({ pricing: { price: 0 } }, { now }), /SERVICE_PRICE_REQUIRED/);
});

test('phase flow: seller submits, only buyer approves; message/complaint permissions', () => {
  const p = { status: 'active', milestones: packageMilestones({ pricing: { price: 9 } }, { now }) };
  assert.throws(() => assertAction(p, 'buyer', 'approve'));
  assert.doesNotThrow(() => assertAction(p, 'seller', 'submit'));
  currentMilestone(p).status = 'submitted';
  currentMilestone(p).submittedAt = now;
  assert.throws(() => assertAction(p, 'seller', 'approve'));
  assert.doesNotThrow(() => assertAction(p, 'buyer', 'approve'));
  assert.equal(advanceAfterApproval(p, { orderId: 'o1', now }), false);
  assert.equal(p.milestones[1].status, 'in_progress');
  assert.doesNotThrow(() => assertAction(p, 'seller', 'message'));
  assert.doesNotThrow(() => assertAction(p, 'buyer', 'complain'));
  assert.throws(() => assertAction(p, 'seller', 'complain'));
});
