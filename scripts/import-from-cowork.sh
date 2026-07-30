#!/bin/bash
# 備援匯入：把 cowork 產在本機的論文 HTML 收進 papers/、重建索引並推上 GitHub。
#
# 主線是 cowork routine 在雲端直接 commit 進 repo（不必開電腦）；
# 這支只是保險：萬一雲端那條斷了，Mac 一開機就會把落在資料夾裡的檔案補推上去。
# 由 launchd（com.jeremy.pubmed-daily-import）在資料夾有變動或每小時觸發。

set -uo pipefail

SRC="/Users/jeremy/Desktop/claude cowork/PubMed 每日文獻"
REPO="/Users/jeremy/Desktop/Claude code/pubmed-daily"
# 紀錄寫在 Application Support：桌面受 macOS 隱私權保護，背景程式在取得
# 「完全取用磁碟」之前連寫 log 都會被擋，log 寫在這裡才看得到失敗原因。
LOG="$HOME/Library/Application Support/pubmed-daily/import.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

[ -d "$SRC" ] || { log "找不到來源資料夾：$SRC"; exit 0; }

# 受保護目錄的 stat 會過、readdir 才被擋，所以要真的列一次才知道有沒有權限。
# 由 launchd 執行時若未授予「完全取用磁碟」，這裡會擋下來並留下明確訊息，
# 不會誤以為「今天沒有新論文」。
ls "$SRC" >/dev/null 2>&1 || {
  log "讀不到 $SRC —— 請到 系統設定 › 隱私權與安全性 › 完全取用磁碟 加入 /bin/bash"
  exit 0
}
[ -d "$REPO" ] || { log "找不到 repo：$REPO"; exit 1; }
cd "$REPO" || exit 1

# 只複製 papers/ 還沒有、或內容不同的檔案
copied=0
shopt -s nullglob
for f in "$SRC"/*.html; do
  base=$(basename "$f")
  if [ ! -f "papers/$base" ] || ! cmp -s "$f" "papers/$base"; then
    # papers/ 裡的檔案被 build.py 注入過工具列，內容本來就會與來源不同，
    # 因此只在「檔案不存在」或「拆掉注入區塊後仍不同」時才覆蓋。
    if [ -f "papers/$base" ] && \
       python3 build.py --strip "papers/$base" 2>/dev/null | cmp -s - "$f"; then
      continue
    fi
    cp "$f" "papers/$base" && chmod 644 "papers/$base" && copied=$((copied + 1))
    log "收進 $base"
  fi
done

[ "$copied" -eq 0 ] && { log "沒有新論文"; exit 0; }

python3 build.py >> "$LOG" 2>&1 || { log "build.py 失敗"; exit 1; }

# 只 commit 本專案自己的檔案（不用 git add -A）
git add papers data sw.js
if git diff --cached --quiet; then
  log "索引無變動"
  exit 0
fi

count=$(python3 -c "import json;print(json.load(open('data/papers.json'))['count'])")
git commit -q -m "新增論文：本機匯入 $copied 篇（共 $count 篇）" && log "已 commit"
git pull -q --rebase --autostash origin main >> "$LOG" 2>&1
if git push -q origin main >> "$LOG" 2>&1; then
  log "已推上 GitHub"
else
  log "push 失敗，下次觸發會再試"
fi
