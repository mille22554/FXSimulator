/* auth.js — M3 登入體驗：/api/me 閘門、登入遮罩、Google 登入、登出。
   原則（m3-auth §7）：不由 client 判斷 session 過期；一切以 /api/me 回應
   與 WS close code（1008 unauthorized）為準。 */

import { $, api } from './util.js?v=6';

const MOCK_USER = { id: 'mock', email: 'mock@fxsimulator.test', name: '模擬預覽', avatar_url: null };

const auth = {
  user: null,        // { id, email, name, avatar_url, role }（contract 形狀）
  devAuth: false,    // /api/me 的 dev_auth；true 時 ?user= 才生效
  gateBound: false,
  busy: false,
  mock: false,
};

export function currentUser() { return auth.user; }
export function isDevAuth() { return auth.devAuth; }

/* ── /api/me：{ ok, status?, user?, dev_auth? }；401／斷線 → ok:false ── */
export async function fetchMe() {
  try {
    const r = await fetch(api('/api/me'), { credentials: 'include' });
    if (r.status === 401) return { ok: false, status: 401 };
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return { ok: true, user: d.user || null, dev_auth: !!d.dev_auth };
  } catch { return { ok: false, status: 0 }; }
}

/* ── 使用者區（頭像／email／登出） ── */
function renderUserChip() {
  const box = $('#topAuth');
  if (!box) return;
  if (!auth.user) { box.hidden = true; return; }
  const u = auth.user;
  const label = (u.name || u.email || '').trim();
  const av = $('#userAvatar');
  if (u.avatar_url) {
    av.style.backgroundImage = `url("${u.avatar_url}")`;
    av.textContent = '';
  } else {
    av.style.backgroundImage = '';
    av.textContent = (label[0] || 'A').toUpperCase();
  }
  const em = $('#userEmail');
  em.textContent = u.email || label;
  em.title = [u.name || '', u.email || ''].filter(Boolean).join(' ');
  box.hidden = false;
}

export function clearUser() {
  auth.user = null;
  auth.devAuth = false;
  renderUserChip();
}

/* ── 登入遮罩 ── */
export function showLogin(note = '') {
  clearUser();
  bindGate();
  const n = $('#gateNote');
  if (n) n.textContent = note || '';
  const btn = $('#googleBtn');
  if (btn) btn.disabled = false;
  auth.busy = false;
  const gate = $('#loginGate');
  if (gate) {
    gate.hidden = false;
    document.body.classList.add('gated');
  }
}

function bindGate() {
  if (auth.gateBound) return;
  auth.gateBound = true;
  const btn = $('#googleBtn');
  if (btn) btn.addEventListener('click', () => { startGoogleSignIn(); });
  const out = $('#signOutBtn');
  if (out) out.addEventListener('click', () => { signOut(); });
}

/* ── Google 登入：POST /api/auth/sign-in/social → { url, redirect } ── */
async function startGoogleSignIn() {
  const btn = $('#googleBtn');
  const note = $('#gateNote');
  if (auth.busy) return;
  auth.busy = true;
  if (btn) btn.disabled = true;
  if (note) note.textContent = '連線 Google 登入服務…';
  try {
    const r = await fetch(api('/api/auth/sign-in/social'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: location.href }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.redirect && d.url) {
      location.href = d.url; // 跳轉 Google；不還原按鈕
      return;
    }
    if (note) note.textContent = (d && d.message) || '無法開始 Google 登入，請稍後再試。';
  } catch {
    if (note) note.textContent = '無法連線登入服務，請確認網路後再試。';
  }
  auth.busy = false;
  if (btn) btn.disabled = false;
}

/* ── 登出：POST /api/auth/sign-out（credentials）→ 重整，讓 /api/me 重新裁決 ── */
async function signOut() {
  const btn = $('#signOutBtn');
  if (btn) btn.disabled = true;
  if (auth.mock) { location.reload(); return; } // mock 預覽不打真實後端
  try {
    await fetch(api('/api/auth/sign-out'), { method: 'POST', credentials: 'include' });
  } catch { /* 不論結果一律重整 */ }
  location.reload();
}

/* ── 啟動。回 true = 已登入（可初始化交易 WS）；false = 已顯示遮罩 ── */
export async function initAuthApp(mock, userIdParam) {
  auth.mock = !!mock;
  if (mock) {
    // mock：跳過 /api/me，預載一個假登入使用者（?user= 行為照常開放）
    auth.user = { ...MOCK_USER };
    auth.devAuth = true;
    if (userIdParam) auth.user.id = userIdParam;
    renderUserChip();
    bindGate();
    return true;
  }
  bindGate();
  const me = await fetchMe();
  if (me.ok && me.user) {
    auth.user = me.user;
    auth.devAuth = me.dev_auth;
    renderUserChip();
    return true;
  }
  if (me.status === 401) showLogin('');
  else if (me.status === 0) showLogin('無法連線伺服器，請確認網路後重試。');
  else showLogin(`無法確認登入狀態（HTTP ${me.status}），請重試。`);
  return false;
}
