/* ws.js — 傳輸層。真實：/ws?user=<id> + 指數退避重連；mock：本地模擬伺服器。
   兩者共用同一種訊息介面（contract 形狀），App 不需知道差別。 */

import { createMockServer } from './mock.js';

export function createTransport({ mock, userId, onStatus, onMessage, mockOpts = {} }) {

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
    ws = new WebSocket(`${proto}//${location.host}/ws?user=${encodeURIComponent(userId)}`);

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
    ws.onclose = () => {
      setPing(false);
      ws = null;
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
