const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  normalizeMilestones,
  assertAction,
  advanceAfterApproval,
  cancelOpenMilestones,
  currentMilestone,
  isOverdue,
  isHireRequestCategory,
  paidTotal,
  roleIn,
} = require('../../src/utils/hire/rules');
const { publicHire } = require('../../src/routes/hire');
const { talentCategoryError, hirePricing, servicePricingError } = require('../../src/routes/products');

const NOW = new Date('2026-10-03T00:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function project(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    buyer: new mongoose.Types.ObjectId(),
    seller: new mongoose.Types.ObjectId(),
    status: 'active',
    quote: { amount: 300 },
    milestones: normalizeMilestones(
      [
        { title: 'Thiết kế', amount: 100, dueAt: day(7) },
        { title: 'Dựng', amount: 100, dueAt: day(14) },
        { title: 'Bàn giao', amount: 100, dueAt: day(21) },
      ],
      { total: 300, now: NOW },
    ).map((m) => ({ ...m, _id: new mongoose.Types.ObjectId() })),
    ...overrides,
  };
}

function code(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

test('milestones must add up to the quote with increasing future due dates', () => {
  const ok = normalizeMilestones(
    [
      { title: 'A', amount: 120, dueAt: day(3) },
      { title: '', amount: 80, dueAt: day(6) },
    ],
    { total: 200, now: NOW },
  );
  assert.equal(ok.length, 2);
  assert.equal(ok[0].status, 'in_progress');
  assert.equal(ok[1].status, 'pending');
  assert.equal(ok[1].title, 'Giai đoạn 2');

  assert.equal(code(() => normalizeMilestones([], { total: 1, now: NOW })), 'MILESTONES_REQUIRED');
  assert.equal(
    code(() => normalizeMilestones([{ amount: 100, dueAt: day(2) }], { total: 150, now: NOW })),
    'MILESTONES_SUM_MISMATCH',
  );
  assert.equal(code(() => normalizeMilestones([{ amount: 100, dueAt: day(-1) }], { total: 100, now: NOW })), 'MILESTONE_DUE_PAST');
  assert.equal(
    code(() =>
      normalizeMilestones(
        [
          { amount: 50, dueAt: day(5) },
          { amount: 50, dueAt: day(4) },
        ],
        { total: 100, now: NOW },
      ),
    ),
    'MILESTONE_DUE_ORDER',
  );
  assert.equal(code(() => normalizeMilestones([{ amount: 0, dueAt: day(2) }], { total: 0, now: NOW })), 'MILESTONE_AMOUNT_INVALID');
  const many = Array.from({ length: 11 }, (_, i) => ({ amount: 1, dueAt: day(i + 1) }));
  assert.equal(code(() => normalizeMilestones(many, { total: 11, now: NOW })), 'MILESTONES_TOO_MANY');
});

test('only the right party can act in each status', () => {
  const p = project({ status: 'requested', milestones: [] });
  assert.equal(code(() => assertAction(p, 'seller', 'quote')), null);
  assert.equal(code(() => assertAction(p, 'buyer', 'quote')), 'HIRE_ACTION_NOT_ALLOWED');
  assert.equal(code(() => assertAction(p, 'buyer', 'accept')), 'HIRE_ACTION_NOT_ALLOWED');
  p.status = 'quoted';
  assert.equal(code(() => assertAction(p, 'buyer', 'accept')), null);
  assert.equal(code(() => assertAction(p, 'buyer', 'counter')), null);

  const a = project();
  assert.equal(code(() => assertAction(a, 'buyer', 'approve')), 'HIRE_ACTION_NOT_ALLOWED');
  assert.equal(code(() => assertAction(a, 'seller', 'submit')), null);
  a.milestones[0].status = 'submitted';
  assert.equal(code(() => assertAction(a, 'seller', 'submit')), 'HIRE_ACTION_NOT_ALLOWED');
  assert.equal(code(() => assertAction(a, 'seller', 'approve')), 'HIRE_ACTION_NOT_ALLOWED');
  assert.equal(code(() => assertAction(a, 'buyer', 'approve')), null);
  assert.equal(code(() => assertAction(a, 'buyer', 'terminate')), null);
  assert.equal(code(() => assertAction(a, 'seller', 'terminate')), 'HIRE_ACTION_NOT_ALLOWED');
});

test('approving phases advances one at a time and completes after the last', () => {
  const p = project();
  const orders = [];
  for (let i = 0; i < 3; i += 1) {
    const m = currentMilestone(p);
    assert.equal(p.milestones.indexOf(m), i);
    m.status = 'submitted';
    const id = new mongoose.Types.ObjectId();
    orders.push(id);
    const done = advanceAfterApproval(p, { orderId: id, now: NOW });
    assert.equal(done, i === 2);
  }
  assert.equal(p.status, 'completed');
  assert.deepEqual(p.milestones.map((m) => m.status), ['approved', 'approved', 'approved']);
  assert.equal(String(p.milestones[2].order), String(orders[2]));
  assert.equal(paidTotal(p), 300);
});

test('terminating cancels unpaid phases and returns the last paid one', () => {
  const p = project();
  p.milestones[0].status = 'submitted';
  advanceAfterApproval(p, { orderId: new mongoose.Types.ObjectId(), now: NOW });
  const last = cancelOpenMilestones(p);
  assert.equal(last, p.milestones[0]);
  assert.deepEqual(p.milestones.map((m) => m.status), ['approved', 'cancelled', 'cancelled']);
  assert.equal(paidTotal(p), 100);
  assert.equal(cancelOpenMilestones(project()), null);
});

test('overdue: not submitted by the due date, or submitted late', () => {
  const p = project();
  const m = p.milestones[0];
  assert.equal(isOverdue(m, NOW), false);
  assert.equal(isOverdue(m, new Date(day(8))), true);
  m.status = 'submitted';
  m.submittedAt = new Date(day(6));
  assert.equal(isOverdue(m, new Date(day(30))), false);
  m.submittedAt = new Date(day(9));
  assert.equal(isOverdue(m, new Date(day(30))), true);
});

test('publicHire exposes role and current phase', () => {
  const p = project();
  assert.equal(roleIn(p, p.buyer), 'buyer');
  assert.equal(roleIn(p, p.seller), 'seller');
  assert.equal(roleIn(p, new mongoose.Types.ObjectId()), null);
  const view = publicHire({ ...p, productName: 'Web', category: 'hire-build-web', brief: 'x' }, p.seller, new Map(), NOW);
  assert.equal(view.role, 'seller');
  assert.equal(view.demoKind, 'web');
  assert.equal(view.currentMilestoneId, String(p.milestones[0]._id));
  assert.equal(view.milestones.length, 3);
});

test('talent may only list the six custom-work categories', () => {
  assert.equal(isHireRequestCategory('hire-seo'), true);
  assert.equal(isHireRequestCategory('hire-agent'), false);
  const talent = { role: 'talent' };
  assert.equal(talentCategoryError(talent, 'hire-build-web'), null);
  assert.equal(talentCategoryError(talent, 'text-to-image')?.code, 'CATEGORY_NOT_ALLOWED');
  assert.equal(talentCategoryError(talent, 'hire-agent')?.code, 'CATEGORY_NOT_ALLOWED');
  assert.equal(talentCategoryError({ role: 'seller' }, 'text-to-image'), null);
});

test('professional services are forced to a fixed one-time package price', () => {
  assert.deepEqual(hirePricing('hire-seo', { model: 'subscription', price: 50, interval: 'month' }), {
    model: 'one-time',
    price: 50,
    currency: 'USD',
    interval: null,
    compareAtPrice: 0,
    negotiable: false,
  });
  assert.equal(hirePricing('hire-seo', { price: 10, negotiable: true }).negotiable, false);
  assert.equal(servicePricingError('hire-seo', { price: 0 })?.code, 'SERVICE_PACKAGE_PRICE_REQUIRED');
  assert.equal(servicePricingError('hire-seo', { price: 99 }), null);
  assert.equal(servicePricingError('text-to-text', { price: 0 }), null);
  const other = { model: 'usage', usageRate: 1 };
  assert.equal(hirePricing('text-to-text', other), other);
});
