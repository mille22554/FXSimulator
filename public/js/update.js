/* update.js — 前端版本更新偵測。
   部署時 index.html 與所有 public/js 的 import 會統一升 ?v=N（同版）。
   本模組比對「自己被抓下來的 ?v=N」與「現在首頁宣告的 app.js?v=M」，
   不一致就通知外部元件（提示玩家重整頁面）。 */

const QUERY_V = /[?&]v=(\d+)/;

/** 本頁正在執行的前端版本（＝本模組被載入時的 ?v=N） */
export function runningVersion() {
  const m = QUERY_V.exec(import.meta.url || '');
  return m ? m[1] : null;
}

/** 由首頁 HTML 取出目前部署的版本（index.html 內 app.js?v=N） */
export function deployedVersion(html) {
  const m = /app\.js\?v=(\d+)/.exec(html || '');
  return m ? m[1] : null;
}

/**
 * 啟動更新偵測。
 * @param {{intervalMs?: number, onOutdated?: (info:{latest:string,running:string}) => void}} opts
 * @returns {{check: () => Promise<void>, stop: () => void} | null}
 */
export function initUpdateWatch({ intervalMs = 60000, onOutdated } = {}) {
  const running = runningVersion();
  if (!running || typeof fetch !== 'function') return null;

  // 首頁 URL：以本模組 URL 往上兩層（.../js/update.js?v=N → .../）
  let root;
  try { root = new URL('..', import.meta.url).href; } catch { return null; }

  let notified = false;
  const check = async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      const res = await fetch(root, { cache: 'no-store' });
      if (!res.ok) return;
      const latest = deployedVersion(await res.text());
      if (latest && latest !== running && !notified) {
        notified = true;
        onOutdated?.({ latest, running });
      }
    } catch { /* 暫時抓不到（離線/重啟中）：下一輪再試 */ }
  };

  const timer = setInterval(check, intervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  // 首次延後檢查，避開初始載入的請求尖峰
  setTimeout(check, 20000);

  return { check, stop: () => clearInterval(timer) };
}
