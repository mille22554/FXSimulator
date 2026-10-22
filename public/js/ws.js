/* ws.js — 傳輸層。真實：/ws?user=<id>（僅 dev_auth 時帶）+ 指數退避重連；
   mock：本地模擬伺服器。兩者共用同一種訊息介面（contract 形狀），App 不需知道差別。
   M3：handshake 被 1008 unauthorized 關閉 → 停止重連，交由 App 的登入流程裁決。 */

import { createMockServer } from './mock.js?v=9';
import { BASE } from './util.js?v=9';

export function createTransport({ mock, userId, onStatus, onMessage, onUnauthorized, mockOpts = {} }) {

  if (mock) {
    const server = createMockServer(mockOpts);
    let session;
    return {
      kind: 'mock',
      async connect() {
        onStatus('mock');
        session = server.attach(m => onMessage(m));
        await session.ready;
      },
      send(msg) { server.handle(msg, session); },
      /** mock REST shim：contract REST 端點（rules/report）由模擬伺服器代答 */
      rest(path, method, body) { return Promise.resolve(server.handleRest(path, method, body)); },
      close() { server.detach(session); },
    };
  }

  // ── 真實 WebSocket ──
  let ws = null;
  let attempt = 0;
  let wanted = true;
  let pingTimer = null;
  let reconnectTimer = null;

  const backoffMs = n => Math.min(30000, 1000 * (2 ** n)); // 1s → 2s → 4s … 上限 30s

  function setPing(on) {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (on) {
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
    }
  }

  function open() {
    if (!wanted) return;
    onStatus(attempt === 0 ? 'connecting' : 'reconnect');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // M3：只有 dev_auth 核可（userId 非 null）才帶 ?user=，純 session 走 /ws
    const qs = userId == null ? '' : `?user=${encodeURIComponent(userId)}`;
    ws = new WebSocket(`${proto}//${location.host}${BASE}/ws${qs}`);

    ws.onopen = () => {
      attempt = 0;
      onStatus('online');
      setPing(true);
    };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') return;
      onMessage(m);
    };
    ws.onclose = e => {
      setPing(false);
      ws = null;
      // M3：handshake 未授權（close code 1008）→ 停止重連，顯示登入遮罩
      if (e && e.code === 1008) {
        wanted = false;
        if (onUnauthorized) { onUnauthorized(); return; }
      }
      if (!wanted) { onStatus('offline'); return; }
      const wait = backoffMs(Math.min(attempt, 5));
      attempt++;
      onStatus('reconnect', attempt, wait);
      reconnectTimer = setTimeout(open, wait);
    };
    ws.onerror = () => { try { ws && ws.close(); } catch { /* noop */ } };
  }

  return {
    kind: 'ws',
    async connect() { wanted = true; open(); },
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      wanted = false;
      clearTimeout(reconnectTimer); setPing(false);
      try { ws && ws.close(); } catch { /* noop */ }
      onStatus('offline');
    },
  };
}
