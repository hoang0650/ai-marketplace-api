const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { renderEmail } = require('../../src/email/templates');
const send = require('../../src/email/send');
const { EMAIL_KEYS, EMAIL_COPY_EN, NOTIFY_COPY } = require('../../src/utils/notify');

const USER = { _id: '64b000000000000000000001', email: 'test@example.invalid', name: 'Hoàng', profile: { notifyLang: 'vi' }, preferences: {} };

describe('transactional email templates', () => {
  test('every template renders vi and en with brand + company footer', () => {
    for (const kind of ['welcome', 'loginNotice', 'passwordReset', 'passwordChanged', 'notification']) {
      for (const l of ['vi', 'en', 'zh']) {
        const m = renderEmail(kind, { l, name: 'A', resetUrl: 'https://aimarkets.vn/reset-password?token=x', title: 'T', body: 'B', href: '/complaints' });
        assert.match(m.subject, /^AI Markets — /);
        assert.match(m.html, /AI Markets/);
        assert.match(m.html, l === 'vi' ? /Công ty TNHH Giải pháp Công nghệ PHGroup/ : /PHGroup Technology Solutions/);
        assert.ok(m.text.length > 20);
      }
    }
  });
  test('escapes html', () => {
    const m = renderEmail('notification', { l: 'vi', name: '<b>x</b>', title: 'x', body: '<script>' });
    assert.doesNotMatch(m.html, /<script>/);
  });
  test('every emailed notification key has vi + en copy', () => {
    for (const k of EMAIL_KEYS) {
      assert.ok(NOTIFY_COPY[k], k);
      assert.ok(EMAIL_COPY_EN[k], k);
    }
  });
});

describe('transactional dispatcher', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    send._resetRateLimit();
    send.setTransport(async (m) => {
      sent.push(m);
      return { ok: true };
    });
  });

  test('sends via mock transport, includes unsubscribe link for login notice', async () => {
    const r = await send.deliver(USER, 'loginNotice', { ip: '1.2.3.4' });
    assert.equal(r.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /unsubscribe/);
    assert.equal(sent[0].to, 'test@example.invalid');
  });
  test('rate limits repeated login notices', async () => {
    await send.deliver(USER, 'loginNotice', {});
    const r = await send.deliver(USER, 'loginNotice', {});
    assert.equal(r.reason, 'RATE_LIMITED');
    assert.equal(sent.length, 1);
  });
  test('respects opt-out for login notices but not for critical mails', async () => {
    const u = { ...USER, preferences: { emailLoginAlerts: false } };
    assert.equal((await send.deliver(u, 'loginNotice', {})).reason, 'OPTED_OUT');
    assert.equal((await send.deliver(u, 'passwordChanged', {})).ok, true);
  });
  test('transport failure is reported, not thrown', async () => {
    send.setTransport(async () => ({ ok: false, error: 'boom' }));
    const r = await send.deliver(USER, 'welcome', {});
    assert.equal(r.ok, false);
  });
  test('unsubscribe token round-trips only for optional kinds', () => {
    const t = send.unsubscribeToken(USER._id, 'loginNotice');
    assert.deepEqual(send.verifyUnsubscribeToken(t), { userId: USER._id, kind: 'loginNotice', pref: 'emailLoginAlerts' });
    assert.equal(send.verifyUnsubscribeToken(send.unsubscribeToken(USER._id, 'passwordReset')), null);
    assert.equal(send.verifyUnsubscribeToken('garbage'), null);
  });
  test('real transport is off without RESEND_API_KEY', async () => {
    send.setTransport(null);
    const r = await send.deliver(USER, 'welcome', {});
    assert.equal(r.skipped, true);
  });
});
