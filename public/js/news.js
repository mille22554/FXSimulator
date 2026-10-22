/* news.js — 桌面右側可收合新聞看板：HH:MM＋標題，依時間列出全部事件；
   重大事件（|jump| ≥1.5%）跳中性事件橫幅（4s 滑入）；點擊定位圖表時間。 */

import { state, eventTimeMs } from './state.js';
import { $, el, fmtHHMM } from './util.js';

let bannerTimer = null;
let lastEventId = null;
let onFirstNewEvent = null;

export function initNews(onFocusEvent) {
  onFirstNewEvent = () => {
    const latest = state.events[0];
    if (latest) maybeBanner(latest);
  };

  $('#newsToggle').addEventListener('click', () => {
    state.ui.newsOpen = !state.ui.newsOpen;
    applyCollapse();
  });

  $('#newsList').addEventListener('click', e => {
    const item = e.target.closest('.news-item');
    if (!item) return;
    state.ui.focusEventTickId = Number(item.dataset.tick);
    renderNews();
    onFocusEvent(state.events.find(v => v.tick_id === state.ui.focusEventTickId));
  });

  applyCollapse();
}

function applyCollapse() {
  const pane = $('#newsPane');
  pane.classList.toggle('news-collapsed', !state.ui.newsOpen);
  pane.classList.toggle('news-open', state.ui.newsOpen);
  $('#newsToggle').setAttribute('aria-expanded', String(state.ui.newsOpen));
  mainGridResize();
  // 收合按鈕文字
  const label = $('.news-toggle-label');
  if (label) label.textContent = '新聞';
}

/* 收合時主圖應跟著變寬 → 觸發一次 resize（ResizeObserver 於 #chartPane 自會反應） */
function mainGridResize() { /* ResizeObserver 監看 chart pane，無需額外邏輯 */ }

export function renderNews() {
  const listUI = $('#newsList');
  const events = state.events;

  $('#newsCount').textContent = events.length ? `${events.length}` : '';
  $('#newsBadge').textContent = events.length ? String(events.length) : '';

  listUI.textContent = '';
  if (!events.length) {
    listUI.appendChild(el('li', 'news-list-empty', '尚無事件。'));
    return;
  }
  for (const ev of events.slice(0, 100)) {
    const li = el('button', 'news-item');
    li.type = 'button';
    li.dataset.tick = String(ev.tick_id);
    li.setAttribute('aria-label', `${fmtHHMM(eventTimeMs(ev))} ${ev.headline}，點擊定位圖表`);
    if (state.ui.focusEventTickId === ev.tick_id) li.classList.add('focused');
    li.append(
      el('span', 'n-time', fmtHHMM(eventTimeMs(ev))),
      el('span', 'n-head', ev.headline),
    );
    listUI.appendChild(li);
  }
}

/* ── 橫幅：重大事件（|jump| ≥ 1.5%）的中性提示，不顯示幅度／方向 ── */
export function maybeBanner(ev) {
  if (lastEventId === ev.id) return;
  lastEventId = ev.id;
  if (Math.abs(ev.impact_jump) < 0.015) return;

  const banner = $('#evBanner');
  banner.className = 'ev-banner';
  $('#evBannerDir').textContent = '市場事件';
  $('#evBannerHead').textContent = ev.headline;
  banner.hidden = false;
  banner.classList.remove('show');
  void banner.offsetWidth; // 重新觸發動畫
  banner.classList.add('show');

  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 4300);
}
