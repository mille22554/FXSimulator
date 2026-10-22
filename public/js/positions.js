/* positions.js — 底部持倉卡片列：方向／名目／進場／槓桿／浮動損益／強平／平倉 */

import { state } from './state.js?v=9';
import { $, el, fmtA, fmtA1, fmtPrice } from './util.js?v=9';

export function initPositions(onClose) {
  renderPositions();

  // 平倉按鈕以事件委派（持倉數會變動）
  const list = $('#posList');
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-close]');
    if (btn) onClose(Number(btn.dataset.close));
  });
}

export function renderPositions() {
  const list = $('#posList');
  const positions = state.positions;
  $('#posCount').textContent = String(positions.length);
  list.textContent = '';

  if (!positions.length) {
    const empty = el('span', 'pos-list-empty', '目前無持倉 — 在右側面板下單後持倉會顯示在這裡。');
    list.appendChild(empty);
    return;
  }

  for (const p of positions) {
    const card = el('div', `pos-card ${p.side === 'long' ? 'long' : 'short'}`);

    const r1 = el('div', 'pos-row1');
    r1.append(
      el('span', 'pos-side', p.side === 'long' ? '多' : '空'),
      el('b', 'pos-notional mono', fmtA(p.notional_milli)),
      el('span', 'pos-lev', `${p.leverage}×`),
    );

    const r2 = el('div', 'pos-row2');
    const e1 = el('span', 'dim', '進場 ');
    const e2 = el('b', '', fmtPrice(p.entry_price_e4));
    r2.append(e1, e2);
    if (p.margin_milli != null) {
      const m1 = el('span', 'dim', '保證金 ');
      const m2 = el('b', '', fmtA(p.margin_milli));
      r2.append(m1, m2);
    }

    const r3 = el('div', 'pos-row3');
    const pnlClass = p.pnl_milli > 0 ? 'up' : p.pnl_milli < 0 ? 'down' : 'dim';
    // 浮動損益：A 幣、1 位小數、帶正負號
    const pnl = el('b', `pos-pnl mono ${pnlClass}`);
    pnl.textContent = `${p.pnl_milli > 0 ? '+' : ''}${fmtA1(p.pnl_milli)}`;
    const liqs = el('span', 'pos-liq');
    liqs.append(el('span', 'dim', '強平 '), el('b', '', fmtPrice(p.liq_price_e4)));
    const closeBtn = el('button', 'pos-close', '平倉');
    closeBtn.dataset.close = String(p.id);

    r3.append(pnl, liqs, closeBtn);

    card.append(r1, r2, r3);
    list.appendChild(card);
  }
}
