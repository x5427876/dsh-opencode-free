#!/usr/bin/env bash
# 上游閘門重驗：紅綠燈。詳見 docs/reverse-engineering.md。
#
#   ./scripts/reverify.sh
#
# 三盞燈：① 目錄可達（公開端點，期望 200）② 匿名 hi（只記錄行為，
# 上游政策會漂，不判死）③ 帶 key hi（僅 OPENCODE_API_KEY 有設時跑）。
# 退出碼：0=腳本跑完；1=目錄不通或帶 key 失敗（真問題）。
set -u

BASE="https://opencode.ai/zen/v1"
MODEL="${ZEN_MODEL:-muse-spark-1.3-contributor-free}"
UA="opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 dsh-opencode-free/0.1.3"
SESS="ses_$(node -e "process.stdout.write(require('crypto').randomBytes(6).toString('hex'))")AbCdEfGhIjKlMn"
REQ="msg_abcdef123456AbCdEfGhIjKlMn"
# 匿名層要求 stream:true，且 tools 含名為 read 與 bash 的工具（2026-09-27 重播實測），缺一即 403。
STUB='"description":"stub","parameters":{"type":"object","properties":{}}'
TOOLS="[{\"type\":\"function\",\"name\":\"read\",$STUB},{\"type\":\"function\",\"name\":\"bash\",$STUB}]"

green() { printf '🟢 %s\n' "$*"; }
yellow() { printf '🟡 %s\n' "$*"; }
red() { printf '🔴 %s\n' "$*"; }

echo "== ① 目錄 $BASE/models =="
code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -H "User-Agent: $UA" "$BASE/models")"
if [ "$code" = "200" ]; then
  green "HTTP 200：上游可達"
else
  red "HTTP $code：上游不可達或被擋，先查網路"
  exit 1
fi

echo "== ② 匿名 hi（model=$MODEL）=="
resp="$(curl -s --max-time 60 -w "\nHTTP:%{http_code}" "$BASE/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -H "User-Agent: $UA" \
  -H "x-opencode-client: cli" \
  -H "x-opencode-project: global" \
  -H "x-opencode-session: $SESS" \
  -H "x-opencode-request: $REQ" \
  -H "x-client-request-id: $SESS" \
  -d "{\"model\":\"$MODEL\",\"input\":\"hi\",\"max_output_tokens\":16,\"stream\":true,\"tools\":$TOOLS}")"
body="$(printf '%s' "$resp" | sed '$d')"
code="$(printf '%s' "$resp" | tail -n 1 | sed 's/HTTP://')"
case "$code" in
  200) green "HTTP 200：匿名存活" ;;
  403)
    if printf '%s' "$body" | grep -q "FreeTierError"; then
      yellow "HTTP 403 FreeTierError：上游拒絕免費層請求（本請求已符合 stream 與 read/bash 條件，閘門可能又變了）"
    else
      red "HTTP 403 非 FreeTierError：$(printf '%s' "$body" | head -c 200)"
    fi
    ;;
  429) yellow "HTTP 429：匿名額度用完，等視窗重置或掛 key" ;;
  *) red "HTTP $code 未知：$(printf '%s' "$body" | head -c 200)" ;;
esac

echo "== ③ 帶 key hi =="
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  yellow "SKIP：未設 OPENCODE_API_KEY"
  exit 0
fi
resp="$(curl -s --max-time 60 -w "\nHTTP:%{http_code}" "$BASE/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  -H "User-Agent: $UA" \
  -H "x-opencode-client: cli" \
  -H "x-opencode-project: global" \
  -H "x-opencode-session: $SESS" \
  -H "x-opencode-request: $REQ" \
  -H "x-client-request-id: $SESS" \
  -d "{\"model\":\"$MODEL\",\"input\":\"hi\",\"max_output_tokens\":16}")"
body="$(printf '%s' "$resp" | sed '$d')"
code="$(printf '%s' "$resp" | tail -n 1 | sed 's/HTTP://')"
if [ "$code" = "200" ]; then
  green "HTTP 200：key 有效"
else
  red "HTTP $code：key 無效或上游異常：$(printf '%s' "$body" | head -c 200)"
  exit 1
fi
