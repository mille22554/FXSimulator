/* chart.js — Canvas 2D 走勢圖（主圖）＋全服淨部位副圖。
   redraw 條件：tick 常壓送、指標移動、resize；形成 K 只在 tick 級別更新。 */

import { state, chartData, netNotionalSeries, candleTimeMS } from './state.js?v=9';
import { fmtPrice, fmtHHMM, fmtCompactA } from './util.js?v=9';

const COLORS = {
  grid: '#161c28',
  gridSoft: '#12161f',
  axis: '#5b6478',
  line: '#5b8dff',
  lineFill: 'rgba(91,141,255,.07)',
  up: '#26d07c',
  down: '#f6465d',
  upDim: 'rgba(38,208,124,.55)',
  downDim: 'rgba(246,70,93,.55)',
  event: '#d9a94e',
  entryLong: '#26d07c',
  entryShort: '#f6465d',
  liq: '#f6465d',
  cross: '#7c8699',
  chipBg: '#232c3e',
  text: '#e8ecf4',
  dim: '#7c8699',
};

export class Chart {
  constructor(mainCanvas, subCanvas, tipEl, subLabelEl) {
    this.main = mainCanvas;
    this.sub = subCanvas;
    this.tip = tipEl;
    this.view = null; // 快取繪圖域，給 crosshair / hit-test 用

    for (const c of [mainCanvas, subCanvas]) {
      const ro = new ResizeObserver(() => this.render());
      ro.observe(c.parentElement);
    }
    this.bindPointer();
  }

  /* ── 指標互動 ── */
  bindPointer() {
    const main = this.main;
    main.addEventListener('mousemove', e => {
      const r = main.getBoundingClientRect();
      state.ui.crosshair = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.tip.hidden = true;
      this.render();
    });
    main.addEventListener('mouseleave', () => {
      state.ui.crosshair = null;
      this.tip.hidden = true;
      this.render();
    });
  }

  /* ── 主繪製 ── */
  render() {
    this.drawMain();
    this.drawSub();
  }

  setup(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 規格：DPR 上限 2
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    if (w < 10 || h < 10) return null;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    return { ctx, w, h };
  }

  /* ── 主圖 ── */
  drawMain() {
    const s = this.setup(this.main);
    if (!s) return;
    const { ctx, w, h } = s;
    const data = chartData();
    const padR = 62, padB = 18, padT = 6, padL = 4;

    // ─ x 域（1H / 4H / 10H） ─
    const rangeMs = Math.max(1, state.ui.chartRange ?? 60) * 60000;
    let t1 = state.serverNow + 90 * 1000;
    let t0 = t1 - rangeMs;

    // ─ y 域（只掃描可見區間，避免舊歷史壓扁當前視窗） ─
    let lo = Infinity, hi = -Infinity;
    const scan = p => { if (p != null && !Number.isNaN(p)) { if (p < lo) lo = p; if (p > hi) hi = p; } };
    const visible = t => t >= t0 && t <= t1;
    if (data.points) data.points.forEach(p => { if (visible(p.t)) scan(p.v); });
    if (data.candles1) data.candles1.forEach(c => { if (visible(c.t)) { scan(c.high_e4); scan(c.low_e4); } });
    if (data.candles5) data.candles5.forEach(c => { if (visible(c.t)) { scan(c.high_e4); scan(c.low_e4); } });
    for (const p of state.positions) { scan(p.entry_price_e4); scan(p.liq_price_e4); }
    if (hi === -Infinity) { lo = 50000; hi = 50100; }
    // 上下各留 10% padding
    if (hi === lo) { hi += 50; lo -= 50; }
    const pad = (hi - lo) * 0.10;
    lo -= pad; hi += pad;

    const plot = { x: padL, y: padT, w: w - padR - padL, h: h - padB - padT };
    const V = this.view = {
      plot, t0, t1, lo, hi,
      timeToX: t => plot.x + plot.w * (t - t0) / (t1 - t0),
      xToTime: x => t0 + (x - plot.x) / plot.w * (t1 - t0),
      yToPrice: py => hi - (py - plot.y) / plot.h * (hi - lo),
      priceToY: p => plot.y + plot.h * (hi - p) / (hi - lo),
      ohlcAt: t => {
        if (state.ui.chartMode === 'm1') {
          const src = [...state.candles, state.forming].filter(Boolean);
          for (const c of src) { const ct = candleTimeMS(c, state.candles.indexOf(c)); if (t >= ct && t < ct + 60000) return c; }
        } else {
          const { candles5 } = chartData();
          for (const c of candles5) { if (t >= c.t && t < c.t + 5 * 60000) return c; }
        }
        return null;
      },
    };

    // ─ 網格 + y 標籤 ─
    ctx.strokeStyle = COLORS.gridSoft;
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    const rows = 5;
    for (let i = 0; i <= rows; i++) {
      const p = lo + (hi - lo) * i / rows;
      const y = Math.round(V.priceToY(p)) + .5;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
      ctx.fillText(fmtPrice(Math.round(p)), plot.x + plot.w + 8, y + 3.5);
    }

    // ─ x 標籤（HH:MM） ─
    ctx.textAlign = 'center';
    const rangeMin = rangeMs / 60000;
    const slotMin = (rangeMin <= 60 ? 15 : rangeMin <= 240 ? 30 : 60) * 60000;
    for (let t = Math.ceil(t0 / slotMin) * slotMin; t <= t1; t += slotMin) {
      const x = Math.round(V.timeToX(t)) + .5;
      if (x < plot.x || x > plot.x + plot.w) continue;
      ctx.strokeStyle = COLORS.gridSoft;
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(fmtHHMM(t), x, h - 5);
    }

    // ─ 自己的進場 / 強平標線 ─
    for (const p of state.positions) {
      const color = p.side === 'long' ? COLORS.entryLong : COLORS.entryShort;
      this.hline(ctx, V, p.entry_price_e4, color, [5, 3], 1);
      const ey = V.priceToY(p.entry_price_e4);
      ctx.fillStyle = color;
      ctx.font = '9px ui-monospace, Consolas, monospace';
      const glyph = p.side === 'long' ? '▲' : '▼';
      ctx.textAlign = 'left';
      ctx.fillText(glyph, plot.x + plot.w - 54, ey - 3);
      ctx.fillText(resolveSideLabel(p.side), plot.x + plot.w - 42, ey - 3);
      if (p.liq_price_e4 != null) {
        this.hline(ctx, V, p.liq_price_e4, COLORS.liq, [2, 3], 1);
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.fillStyle = COLORS.liq;
        ctx.textAlign = 'left';
        const ly = V.priceToY(p.liq_price_e4);
        ctx.fillText('強平 ' + fmtPrice(p.liq_price_e4), plot.x + plot.w - 76, ly - 3);
      }
    }

    // ─ 資料本體 ─
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
    if (data.points) {
      const pts = data.points.map(p => ({ x: V.timeToX(p.t), y: V.priceToY(p.v), live: p.live }));
      if (pts.length > 1) {
        // 平緩底色（單色低透明，無漸層）
        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.lineTo(pts[pts.length - 1].x, V.priceToY(lo));
        ctx.lineTo(pts[0].x, V.priceToY(lo));
        ctx.closePath();
        ctx.fillStyle = COLORS.lineFill; ctx.fill();

        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1.75; ctx.setLineDash([]); ctx.stroke();

        // 最後一點脈動圓點
        const lp = pts[pts.length - 1];
        const ph = (Math.sin(Date.now() / 500) + 1) / 2; // 0..1
        ctx.fillStyle = COLORS.line;
        ctx.beginPath(); ctx.arc(lp.x, lp.y, 2.6, 0, 7); ctx.fill();
        ctx.globalAlpha = .35 * ph;
        ctx.beginPath(); ctx.arc(lp.x, lp.y, 4 + ph * 5, 0, 7);
        ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1; ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (data.candles1) this.drawCandles(ctx, V, data.candles1, c => ({ t: c.t ?? candleTimeMS(c, -1), c }));
    if (data.candles5) this.drawCandles(ctx, V, data.candles5, c => ({ t: c.t, c }));
    ctx.restore();

    // ─ 最新價標籤（漲跌色） ─
    if (state.market.price_e4 != null) {
      const y = V.priceToY(state.market.price_e4);
      const dir = state.priceDir;
      ctx.fillStyle = dir >= 0 ? COLORS.up : COLORS.down;
      ctx.fillRect(plot.x + plot.w + 2, y - 8, padR - 4, 16);
      ctx.fillStyle = '#0a0d13';
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(state.market.price_e4), plot.x + plot.w + 6, y + 3.5);
    }

    // ─ 十字線 ─
    const ch = state.ui.crosshair;
    if (ch && ch.x >= plot.x && ch.x <= plot.x + plot.w && ch.y >= plot.y && ch.y <= plot.y + plot.h) {
      ctx.save();
      ctx.strokeStyle = COLORS.cross; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plot.x, Math.round(ch.y) + .5); ctx.lineTo(plot.x + plot.w, Math.round(ch.y) + .5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(Math.round(ch.x) + .5, plot.y); ctx.lineTo(Math.round(ch.x) + .5, plot.y + plot.h); ctx.stroke();

      // y 晶片
      const pY = V.yToPrice(ch.y);
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.chipBg;
      ctx.fillRect(plot.x + plot.w + 2, ch.y - 8, padR - 4, 16);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(Math.round(pY)), plot.x + plot.w + 6, ch.y + 3.5);

      // x 晶片
      const tm = new Date(V.xToTime(ch.x));
      const label = fmtHHMM(tm);
      const tw = ctx.measureText(label).width + 10;
      const cx = Math.max(plot.x, Math.min(ch.x - tw / 2, plot.x + plot.w - tw));
      ctx.fillStyle = COLORS.chipBg;
      ctx.fillRect(cx, plot.y + plot.h + 2, tw, 14);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx + tw / 2, plot.y + plot.h + 12.5);
      ctx.restore();
    }

    // 頂部資訊（十字線下的 OHLC）
    const cros = this.lastCross;
    const infoEl = this.infoEl;
    if (cros && cros.ohlc) {
      // OHLC 由事件命中提示取代；此處不重複
    }
  }

  static fontStr() { return '10px ui-monospace, Consolas, monospace'; }

  hline(ctx, V, price, color, dash, width) {
    if (price == null) return;
    const y = Math.round(V.priceToY(price)) + .5;
    const { plot } = V;
    if (y < plot.y - 4 || y > plot.y + plot.h + 4) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = .8; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.restore();
  }

  drawCandles(ctx, V, list, getTimeCandle) {
    const firstT = list.length ? getTimeCandle(list[0]).t : V.t0;
    const secondT = list.length > 1 ? getTimeCandle(list[1]).t : firstT + 60000;
    const step = Math.max(1, Math.abs(secondT - firstT));
    const cw = V.plot.w * step / Math.max(V.t1 - V.t0, 1);
    const bodyW = Math.max(2, Math.min(cw - 2, 11));
    for (const c of list) {
      const { t } = getTimeCandle(c);
      const x = V.timeToX(t + step / 2); // K 中央
      if (x < V.plot.x - 20 || x > V.plot.x + V.plot.w + 20) continue;
      const o = Number(c.open_e4), cl = Number(c.close_e4);
      if (!Number.isFinite(o) || !Number.isFinite(cl)) continue;
      // 影線缺值時退回實體範圍，確保細線一定連著粗線、不會整根消失
      let h = Number(c.high_e4); if (!Number.isFinite(h)) h = Math.max(o, cl);
      let l = Number(c.low_e4);  if (!Number.isFinite(l)) l = Math.min(o, cl);
      const hi = Math.max(h, o, cl), lo = Math.min(l, o, cl);
      const up = cl >= o;
      const color = up ? COLORS.up : COLORS.down;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      // 影線（一律包住實體，避免細線與粗線看起來分開）
      const xh = x;
      ctx.beginPath();
      ctx.moveTo(xh, V.priceToY(hi)); ctx.lineTo(xh, V.priceToY(lo));
      ctx.stroke();
      // 實體
      const yO = V.priceToY(o), yC = V.priceToY(cl);
      const top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yO - yC));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    }
  }

  firstCandleTime() {
    const first = state.candles[0];
    return first ? candleTimeMS(first, 0) : state.serverNow - 3600 * 1000;
  }

  /* ── 副圖：全服淨部位（柱狀，正綠負紅，主圖高度 20%） ── */
  drawSub() {
    const s = this.setup(this.sub);
    if (!s) return;
    const { ctx, w, h } = s;
    const all = netNotionalSeries();
    const keep = Math.max(2, Math.ceil(state.ui.chartRange ?? 60) + 1);
    const arr = all.slice(-keep);
    if (!arr.length) return;
    const padR = 62;
    const maxV = Math.max(Math.abs(...arr), 1000) * 1.1;
    const zero = h / 2;

    ctx.strokeStyle = COLORS.gridSoft;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, Math.round(zero) + .5); ctx.lineTo(w, Math.round(zero) + .5); ctx.stroke();

    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.font = Chart.fontStr();
    ctx.fillText(fmtCompactA(Math.round(maxV)), w - padR + 8, 10);
    ctx.fillText(fmtCompactA(Math.round(-maxV)), w - padR + 8, h - 3);
    ctx.fillStyle = COLORS.dim;
    ctx.fillText('A', w - padR + 8, h / 2 + 3.5);

    const n = arr.length;
    const bw = Math.max(1.5, (w - padR) / n - 1);
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (!v) continue;
      const x = ((w - padR) / n) * (i + .5);
      const bh = Math.abs(v) / maxV * (h / 2);
      ctx.fillStyle = v > 0 ? COLORS.up : COLORS.down;
      ctx.globalAlpha = i === n - 1 ? 1 : .8;
      ctx.fillRect(x - bw / 2, v > 0 ? zero - bh : zero, bw, bh);
    }
    ctx.globalAlpha = 1;
  }
}

function resolveSideLabel(side) { return side === 'long' ? '多' : '空'; }
