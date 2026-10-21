/**
 * 事件模型驗收（spec §4.2、§10「事件模型」）。
 *   10. 10,000 次重大事件：黏著型 1.5～3%、永久比例 30～70%
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/rng.js';
import { sampleEvent } from '../src/market.js';

test('10. 10,000 次重大事件：黏著率 1.5～3%、黏著永久比例 30～70%', () => {
  const rng = new Rng(42);
  const N = 10_000;
  let sticky = 0;
  const shares = [];

  for (let i = 0; i < N; i++) {
    const ev = sampleEvent(rng, 'major');
    assert.ok(ev.permanentShare === 0 || (ev.permanentShare >= 0.3 && ev.permanentShare <= 0.7));
    assert.ok(Math.abs(ev.pct) >= 0.015 && Math.abs(ev.pct) <= 0.04, `重大事件幅度 ${ev.pct}`);
    if (ev.isSticky) {
      sticky += 1;
      shares.push(ev.permanentShare);
    }
  }

  const rate = sticky / N;
  assert.ok(rate >= 0.015 && rate <= 0.03, `黏著率 ${(rate * 100).toFixed(3)}% 應落在 1.5%～3%`);
  assert.ok(shares.length > 0);
  for (const s of shares) {
    assert.ok(s >= 0.3 && s <= 0.7, `永久比例 ${s} 應落在 30%～70%`);
  }
});

test('10b. 結構事件 100% 永久；新聞事件無永久比例', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 1000; i++) {
    const s = sampleEvent(rng, 'structural');
    assert.equal(s.permanentShare, 1);
    assert.equal(s.lambda, 0);
    assert.equal(s.sigma, 0);
    assert.ok(Math.abs(s.pct) >= 0.02 && Math.abs(s.pct) <= 0.05);

    const n = sampleEvent(rng, 'news');
    assert.equal(n.permanentShare, 0);
    assert.equal(n.isSticky, false);
    assert.ok(n.halfLifeSec >= 15 * 60 && n.halfLifeSec <= 30 * 60);
    assert.ok(Math.abs(n.pct) >= 0.003 && Math.abs(n.pct) <= 0.01);
  }
});

test('10c. 同種子重播：事件序列可重現', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  for (let i = 0; i < 500; i++) {
    assert.deepEqual(sampleEvent(a, 'major'), sampleEvent(b, 'major'));
  }
});
