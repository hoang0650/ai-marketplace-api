const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Order = require('../../src/models/Order');
const Attachment = require('../../src/models/Attachment');
const { resolveAdminPhone } = require('../../src/utils/admin-phone');
const { resolveOrderDispute } = require('../../src/utils/resolve-order-dispute');
const {
  ADMIN_DISPUTE_LABEL,
  disputePartyRole,
  assertCanViewDispute,
  assertCanResolveDispute,
  buildDisputeMessage,
  planDisputeResolution,
  wantsPagedDisputes,
  disputePartyNames,
  disputeListFilter,
  applyDisputeOpen,
} = require('../../src/utils/dispute-access');
const { findDisputeSellerIds, mapAdminDisputeRows, mapDisputeDetail } = require('../../src/utils/dispute-thread');

function id() {
  return new mongoose.Types.ObjectId();
}

function openOrder(overrides = {}) {
  const buyer = overrides.buyer || id();
  const seller = overrides.seller || id();
  return {
    _id: overrides._id || id(),
    amount: 100,
    sellerNetAmount: 72,
    currency: 'USD',
    productName: 'Widget',
    buyer,
    seller,
    buyerName: 'Buyer',
    ownershipType: 'THIRD_PARTY_SELLER',
    status: 'paid',
    paymentStatus: 'paid',
    disputeStatus: 'open',
    disputeMessages: [],
    disputeEvents: [],
    saved: 0,
    async save() {
      this.saved += 1;
      return this;
    },
    ...overrides,
  };
}

function deps() {
  const calls = { refund: [], notify: [], audit: [], update: [] };
  return {
    calls,
    notifyUser: async (...args) => {
      calls.notify.push(args);
    },
    createRefund: async (input) => {
      calls.refund.push(input);
      const ratio = input.amount / 100;
      return {
        duplicate: false,
        reversed: { grossAmount: input.amount, sellerNetAmount: Math.round(72 * ratio * 100) / 100 },
        refund: { amount: input.amount },
      };
    },
    writeAuditLog: async (entry) => {
      calls.audit.push(entry);
    },
    updateOne: async (...args) => {
      calls.update.push(args);
    },
    findById: async () => null,
  };
}

test('phone comes from the shop contact number and is not marked verified', () => {
  assert.deepEqual(resolveAdminPhone({}), { number: null, source: null, verified: null });
  assert.deepEqual(resolveAdminPhone({ sellerProfile: { contactPhone: '   ' } }), {
    number: null,
    source: null,
    verified: null,
  });
  assert.deepEqual(resolveAdminPhone({ sellerProfile: { contactPhone: ' 0901 234 567 ' } }), {
    number: '0901 234 567',
    source: 'shop',
    verified: null,
  });
});

test('only the buyer, seller, or an admin can see a dispute', () => {
  const buyer = id();
  const seller = id();
  const order = openOrder({ buyer, seller });
  const stranger = { _id: id(), role: 'buyer', name: 'Nope' };
  assert.equal(disputePartyRole({ _id: buyer, role: 'buyer' }, order), 'buyer');
  assert.equal(disputePartyRole({ _id: seller, role: 'seller' }, order), 'seller');
  assert.equal(disputePartyRole({ _id: id(), role: 'admin' }, order), 'admin');
  assert.equal(disputePartyRole(stranger, order), null);
  assert.equal(assertCanViewDispute({ _id: buyer, role: 'buyer', name: 'B' }, order), 'buyer');
  assert.throws(() => assertCanViewDispute(stranger, order), (err) => err.status === 404 && err.code === 'DISPUTE_NOT_FOUND');
  assert.throws(
    () => assertCanViewDispute({ _id: buyer, role: 'buyer' }, { ...order, disputeStatus: 'none' }),
    (err) => err.status === 404,
  );
  assert.throws(() => assertCanResolveDispute({ _id: buyer, role: 'buyer' }, order), (err) => err.status === 403);
  assert.throws(() => assertCanResolveDispute({ _id: id(), role: 'admin' }, null), (err) => err.status === 404);
  assert.equal(assertCanResolveDispute({ _id: id(), role: 'admin' }, order), 'admin');
});

test('a party cannot forge an admin message', () => {
  const buyer = id();
  const order = openOrder({ buyer });
  const message = buildDisputeMessage(
    { _id: buyer, role: 'buyer', name: 'Lan' },
    order,
    { body: 'Here is the screen recording', role: 'admin' },
  );
  assert.equal(message.role, 'buyer');
  assert.equal(message.authorName, 'Lan');
  const staff = buildDisputeMessage({ _id: id(), role: 'admin', name: 'Staff' }, order, { body: 'We are reviewing this' });
  assert.equal(staff.role, 'admin');
  assert.equal(staff.authorName, ADMIN_DISPUTE_LABEL);
  assert.throws(() => buildDisputeMessage({ _id: buyer, role: 'buyer', name: 'Lan' }, order, { body: '  ' }), (err) => err.status === 400);
});

test('dispute list stays an array until the caller asks to page, filter, or search', () => {
  assert.equal(wantsPagedDisputes({}), false);
  assert.equal(wantsPagedDisputes({ status: 'open' }), true);
  assert.equal(wantsPagedDisputes({ q: 'web' }), true);
  assert.deepEqual(disputeListFilter({ status: 'open' }), { disputeStatus: 'open' });
  assert.deepEqual(disputeListFilter({ status: 'resolved' }).disputeStatus.$in, ['seller_win', 'buyer_win', 'split']);
  const q = 'a'.repeat(24);
  const filtered = disputeListFilter({ status: 'open', q, rx: /web/i });
  assert.equal(filtered.$and[0].disputeStatus, 'open');
  assert.equal(filtered.$and[1].$or.some((clause) => clause._id === q), true);
});

test('dispute party names prefer the live account, then the shop or the order snapshot', () => {
  const order = { buyerName: 'On the order' };
  assert.deepEqual(
    disputePartyNames(order, {
      buyer: { name: 'Mai' },
      seller: { name: 'Hoa' },
      profile: { displayName: 'Ignored Shop' },
    }),
    { buyerName: 'Mai', sellerName: 'Hoa' },
  );
  assert.deepEqual(
    disputePartyNames(order, {
      buyer: { name: '   ' },
      seller: { name: '' },
      profile: { displayName: ' Studio B ' },
    }),
    { buyerName: 'On the order', sellerName: 'Studio B' },
  );
  assert.deepEqual(disputePartyNames(order, {}), { buyerName: 'On the order', sellerName: '' });
});

function queryResult(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value,
  };
}

test('admin dispute list rows include the current buyer and seller names', async () => {
  const buyerA = id();
  const sellerA = id();
  const buyerB = id();
  const sellerB = id();
  const rows = await mapAdminDisputeRows(
    [
      openOrder({ buyer: buyerA, seller: sellerA, buyerName: 'Old A' }),
      openOrder({ buyer: buyerB, seller: sellerB, buyerName: 'Old B' }),
    ],
    {
      User: {
        find() {
          return queryResult([
            { _id: buyerA, name: 'Mai' },
            { _id: sellerA, name: 'Hoa' },
            { _id: buyerB, name: '  ' },
            { _id: sellerB, name: '' },
          ]);
        },
      },
      SellerProfile: {
        find() {
          return queryResult([
            { user: sellerA, displayName: 'Ignored Shop' },
            { user: sellerB, displayName: 'Studio B' },
          ]);
        },
      },
    },
  );
  assert.equal(rows[0].buyerName, 'Mai');
  assert.equal(rows[0].sellerName, 'Hoa');
  assert.equal(rows[1].buyerName, 'Old B');
  assert.equal(rows[1].sellerName, 'Studio B');
});

test('dispute detail exposes sellerName, buyerName, seller.name, and buyer.name', async () => {
  const buyer = id();
  const seller = id();
  const order = openOrder({ buyer, seller, buyerName: 'On the order' });
  const detail = await mapDisputeDetail(
    order,
    { viewerRole: 'admin' },
    {
      User: {
        find() {
          return queryResult([
            { _id: buyer, name: '   ', email: 'b@x.vn', role: 'buyer' },
            { _id: seller, name: '', email: 's@x.vn', creatorSlug: 'hoa', role: 'seller' },
          ]);
        },
      },
      SellerProfile: {
        findOne() {
          return queryResult({ user: seller, displayName: 'Hoa Studio' });
        },
      },
      Complaint: {
        findOne() {
          return queryResult(null);
        },
      },
      AuditLog: {
        find() {
          return queryResult([]);
        },
      },
    },
  );
  assert.equal(detail.buyerName, 'On the order');
  assert.equal(detail.buyer.name, 'On the order');
  assert.equal(detail.sellerName, 'Hoa Studio');
  assert.equal(detail.seller.name, 'Hoa Studio');

  const named = await mapDisputeDetail(
    order,
    { viewerRole: 'buyer' },
    {
      User: {
        find() {
          return queryResult([
            { _id: buyer, name: 'Mai', role: 'buyer' },
            { _id: seller, name: 'Hoa', creatorSlug: 'hoa', role: 'seller' },
          ]);
        },
      },
      SellerProfile: {
        findOne() {
          return queryResult({ user: seller, displayName: 'Ignored Shop' });
        },
      },
      Complaint: {
        findOne() {
          return queryResult(null);
        },
      },
    },
  );
  assert.equal(named.buyerName, 'Mai');
  assert.equal(named.buyer.name, 'Mai');
  assert.equal(named.sellerName, 'Hoa');
  assert.equal(named.seller.name, 'Hoa');
});

test('admin dispute search also matches the seller account name and shop display name', async () => {
  const seller = id();
  const shop = id();
  const rx = /lan/i;
  const queries = [];
  const sellerIds = await findDisputeSellerIds(rx, {
    User: {
      find(query) {
        queries.push(query);
        return queryResult([{ _id: seller }]);
      },
    },
    SellerProfile: {
      find(query) {
        queries.push(query);
        return queryResult([{ user: shop }, { user: seller }]);
      },
    },
  });
  assert.deepEqual(queries, [{ name: rx }, { displayName: rx }]);
  const filtered = disputeListFilter({ status: 'open', q: 'lan', rx, sellerIds });
  const or = filtered.$and[1].$or;
  assert.equal(filtered.$and[0].disputeStatus, 'open');
  assert.equal(or[0].productName, rx);
  assert.equal(or[1].buyerName, rx);
  assert.equal(or[2].disputeReason, rx);
  assert.equal(or[3].disputeResolutionNote, rx);
  assert.deepEqual(
    or.find((clause) => clause.seller).seller.$in,
    [String(seller), String(shop)],
  );
});

test('opening a dispute stores the claim and drops non-http evidence', () => {
  const order = {
    status: 'paid',
    amount: 20,
    sellerNetAmount: 16,
    ownershipType: 'THIRD_PARTY_SELLER',
    disputeStatus: 'none',
    buyer: id(),
    buyerName: 'An',
    completedAt: new Date(),
    payoutHoldUntil: new Date(Date.now() + 60 * 60 * 1000),
  };
  applyDisputeOpen(order, {
    reason: 'File will not open',
    actorName: 'An',
    actorId: order.buyer,
    evidenceUrls: ['https://cdn.example.com/proof.png', 'javascript:alert(1)'],
  });
  assert.equal(order.disputeStatus, 'open');
  assert.equal(order.disputeMessages[0].kind, 'opened');
  assert.equal(order.disputeMessages[0].role, 'buyer');
  assert.deepEqual(order.disputeEvidenceUrls, ['https://cdn.example.com/proof.png']);
  assert.equal(order.disputeEvents[0].action, 'opened');
  assert.throws(() => applyDisputeOpen(order, { reason: 'again please' }), (err) => err.code === 'DISPUTE_WINDOW_CLOSED');
});

test('seller win releases the hold and does not move money', async () => {
  const order = openOrder();
  const d = deps();
  d.findById = async () => order;
  const result = await resolveOrderDispute(
    order,
    { resolution: 'seller', note: 'Delivery matches the listing', actorId: id(), requireNote: true },
    d,
  );
  assert.equal(result.disputeStatus, 'seller_win');
  assert.equal(result.disputeOutcome, 'seller');
  assert.equal(result.disputeSellerKeptAmount, 72);
  assert.equal(d.calls.refund.length, 0);
  assert.deepEqual(
    d.calls.notify.map((n) => n[1]),
    ['dispute.closedSeller', 'dispute.closedBuyer'],
  );
  assert.equal(result.disputeMessages.at(-1).authorName, ADMIN_DISPUTE_LABEL);
  assert.equal(result.disputeMessages.at(-1).kind, 'decision');
  assert.equal(d.calls.audit[0].action, 'dispute.resolve');
  assert.equal(d.calls.audit[0].reason, 'Delivery matches the listing');
  assert.equal(d.calls.audit[0].newValue.disputeStatus, 'seller_win');
});

test('buyer full refund uses createRefund for the whole order', async () => {
  const order = openOrder();
  const d = deps();
  await resolveOrderDispute(order, { resolution: 'buyer', note: 'Not delivered', actorId: id(), requireNote: true }, d);
  assert.equal(order.disputeStatus, 'buyer_win');
  assert.equal(order.disputeOutcome, 'buyer_full');
  assert.equal(d.calls.refund[0].amount, 100);
  assert.equal(d.calls.refund[0].eventId, `dispute_refund_${order._id}`);
  assert.deepEqual(
    d.calls.notify.map((n) => n[1]),
    ['dispute.refundBuyer', 'dispute.refundSeller'],
  );
});

test('partial buyer win refunds only the requested amount', async () => {
  const order = openOrder();
  const d = deps();
  const plan = planDisputeResolution(order, { resolution: 'buyer', refundAmount: 40, note: 'Partial outage' });
  assert.equal(plan.outcome, 'buyer_partial');
  assert.equal(plan.disputeStatus, 'buyer_win');
  assert.equal(plan.refundGross, 40);
  assert.equal(plan.sellerKept, 43.2);
  await resolveOrderDispute(
    order,
    { resolution: 'buyer', refundAmount: 40, note: 'Partial outage of the demo', actorId: id(), requireNote: true },
    d,
  );
  assert.equal(d.calls.refund[0].amount, 40);
  assert.equal(order.disputeStatus, 'buyer_win');
  assert.ok(d.calls.notify.some((n) => n[1] === 'dispute.decided' && n[2].outcomeCode === 'buyer_partial'));
  assert.equal(d.calls.update[0][1].$set.disputeRefundAmount, 40);
});

test('split refunds the buyer share through createRefund and releases the rest', async () => {
  const order = openOrder();
  const d = deps();
  await resolveOrderDispute(
    order,
    { resolution: 'split', refundAmount: 30, note: 'Both sides delivered part', actorId: id(), requireNote: true },
    d,
  );
  assert.equal(order.disputeStatus, 'split');
  assert.equal(order.disputeOutcome, 'split');
  assert.equal(d.calls.refund.length, 1);
  assert.equal(d.calls.refund[0].amount, 30);
  assert.equal(d.calls.audit[0].newValue.outcome, 'split');
  assert.ok(d.calls.notify.filter((n) => n[1] === 'dispute.decided').length === 2);
});

test('resolution rejects a missing reason, a closed dispute, and a bad split', async () => {
  const order = openOrder();
  const d = deps();
  await assert.rejects(
    () => resolveOrderDispute(order, { resolution: 'seller', note: 'no', requireNote: true }, d),
    (err) => err.code === 'DISPUTE_REASON_REQUIRED',
  );
  assert.equal(order.disputeStatus, 'open');
  assert.equal(d.calls.refund.length, 0);
  await assert.rejects(
    () => resolveOrderDispute(order, { resolution: 'split', refundAmount: 100, note: 'This is long enough' }, d),
    (err) => err.code === 'DISPUTE_AMOUNT',
  );
  await assert.rejects(
    () => resolveOrderDispute(order, { resolution: 'buyer', refundAmount: 150, note: 'This is long enough' }, d),
    (err) => err.code === 'DISPUTE_AMOUNT',
  );
  order.disputeStatus = 'seller_win';
  await assert.rejects(
    () => resolveOrderDispute(order, { resolution: 'buyer', note: 'This is long enough' }, d),
    (err) => err.code === 'DISPUTE_NOT_OPEN',
  );
});

test('a duplicate refund does not notify or audit again', async () => {
  const order = openOrder();
  const d = deps();
  d.createRefund = async () => ({ duplicate: true });
  await resolveOrderDispute(order, { resolution: 'buyer', note: 'Not delivered', actorId: id() }, d);
  assert.equal(d.calls.notify.length, 0);
  assert.equal(d.calls.audit.length, 0);
  assert.equal(order.disputeStatus, 'buyer_win');
});

test('dispute messages and the dispute attachment scope validate', () => {
  const order = new Order({
    product: id(),
    productName: 'Widget',
    buyer: id(),
    buyerName: 'B',
    seller: id(),
    amount: 10,
    disputeStatus: 'split',
    disputeOutcome: 'split',
  });
  order.disputeMessages.push({ author: order.buyer, role: 'hacker', body: 'no' });
  assert.ok(order.validateSync());
  order.disputeMessages[0].role = 'admin';
  order.disputeMessages[0].authorName = ADMIN_DISPUTE_LABEL;
  assert.equal(order.validateSync(), undefined);

  const file = new Attachment({
    owner: id(),
    scope: 'dispute',
    scopeId: id(),
    objectName: 'dispute/a.png',
    name: 'a.png',
    mime: 'image/png',
    size: 12,
    kind: 'image',
  });
  assert.equal(file.validateSync(), undefined);
});
