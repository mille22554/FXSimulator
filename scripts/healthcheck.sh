#!/bin/sh
# FXSimulator 健康檢查（每 5 分鐘由 /etc/cron.d/fxsim 呼叫）
#
#   1) 本地 /healthz 失敗 → 重啟 fxsim.service（systemd Restart=always 之外的第二道）
#   2) 本地正常但對外 https 失敗 → 重啟 cloudflared（tunnel / DNS 問題）
#   3) 每次異常寫一行到 /var/log/fxsim-health.log
#   4) 若 /etc/fxsim-alert.url 存在 → 額外推播（見下方 alert()）
#
# 手動執行：sudo /usr/local/sbin/fxsim-healthcheck.sh

set -u

LOG=/var/log/fxsim-health.log
LOCAL=http://127.0.0.1:2641/healthz
PUBLIC=https://morowin.win/FXSimulator/healthz
ALERT_FILE=/etc/fxsim-alert.url

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 推播（可選）：檔案內容 = webhook URL
#   ntfy：https://ntfy.sh/<topic>            → 以純文字 POST（手機裝 ntfy 訂閱同 topic）
#   Discord/Slack/Mattermost：webhook URL    → 以 JSON POST（同時帶 content/text 兩個鍵）
alert() {
  [ -f "$ALERT_FILE" ] || return 0
  url=$(tr -d '\r\n' < "$ALERT_FILE" 2>/dev/null)
  [ -n "$url" ] || return 0
  msg="[FXSimulator] $(hostname) $*"
  case "$url" in
    *ntfy*)
      curl -fsS -m 8 -X POST -H 'Title: FXSimulator' -d "$msg" "$url" >/dev/null 2>&1 || true
      ;;
    *)
      curl -fsS -m 8 -X POST -H 'Content-Type: application/json' \
        -d "{\"content\":\"$msg\",\"text\":\"$msg\"}" "$url" >/dev/null 2>&1 || true
      ;;
  esac
}

log() { echo "$(ts) $*" >> "$LOG"; alert "$@"; }

local_ok=1
if ! curl -fsS -m 5 "$LOCAL" >/dev/null 2>&1; then
  local_ok=0
  log "fxsim /healthz FAIL (local) -> restart fxsim.service"
  systemctl restart fxsim.service
  sleep 8
  if curl -fsS -m 5 "$LOCAL" >/dev/null 2>&1; then
    log "fxsim recovered after restart"
  else
    log "fxsim STILL DOWN after restart"
  fi
fi

# 對外檢查（只有本地正常時才有意義）
if [ "$local_ok" = "1" ]; then
  if ! curl -fsS -m 8 "$PUBLIC" >/dev/null 2>&1; then
    log "public /FXSimulator/healthz FAIL (tunnel?) -> restart cloudflared"
    systemctl restart cloudflared
  fi
fi

if ! systemctl is-active --quiet cloudflared; then
  log "cloudflared inactive -> restart"
  systemctl restart cloudflared
fi

exit 0
