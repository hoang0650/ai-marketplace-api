const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOpenClawNote,
  mapOpenClawTx,
  summarizeUsageItems,
} = require('../src/utils/buyer-usage');

describe('buyer-usage', () => {
  it('parses OpenClaw wallet notes', () => {
    const p = parseOpenClawNote(
      'OpenClaw openrouter/free (+25% provider markup) in=120 out=80'
    );
    assert.equal(p.model, 'openrouter/free');
    assert.equal(p.markup, 0.25);
    assert.equal(p.inputTokens, 120);
    assert.equal(p.outputTokens, 80);
  });

  it('parses Hermes wallet notes', () => {
    const { parseAgentUsageNote } = require('../src/utils/buyer-usage');
    const p = parseAgentUsageNote(
      'Hermes featherless/foo (+25% provider markup) in=10 out=5'
    );
    assert.equal(p.channel, 'hermes');
    assert.equal(p.model, 'featherless/foo');
    assert.equal(p.inputTokens, 10);
    assert.equal(p.outputTokens, 5);
  });

  it('maps meta.channel openclaw txs', () => {
    const row = mapOpenClawTx({
      _id: 'abc',
      amount: 0.0125,
      currency: 'USD',
      note: 'OpenClaw x',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      meta: {
        channel: 'openclaw',
        model: 'featherless/foo',
        inputTokens: 10,
        outputTokens: 5,
        markup: 0.25,
      },
    });
    assert.equal(row.source, 'openclaw');
    assert.equal(row.tokens, 15);
    assert.equal(row.amount, 0.0125);
    assert.equal(row.model, 'featherless/foo');
  });

  it('summarizes items', () => {
    const s = summarizeUsageItems([
      { amount: 1.2, inputTokens: 10, outputTokens: 5, tokens: 15 },
      { amount: 0.3, inputTokens: 2, outputTokens: 3, tokens: 5 },
    ]);
    assert.equal(s.requests, 2);
    assert.equal(s.totalCharged, 1.5);
    assert.equal(s.totalTokens, 20);
  });
});
