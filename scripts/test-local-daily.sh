#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ungveloper/Desktop/UNG/problem-solving-research-web"
ENV_FILE="$ROOT/.env.local"
PORT="${LOCAL_TEST_PORT:-3117}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${TMPDIR:-/tmp}/problem-solving-research-local-${PORT}-$$.log"

cd "$ROOT"

if [[ ! -f "$ENV_FILE" ]]; then
  echo ".env.local 파일을 찾을 수 없습니다: $ENV_FILE" >&2
  exit 1
fi

read_env() {
  python3 - "$ENV_FILE" "$1" <<'PY'
from pathlib import Path
import sys
path, key = sys.argv[1], sys.argv[2]
for raw in Path(path).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    if k.strip() != key:
        continue
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in {'"', "'"}:
        v = v[1:-1]
    print(v)
    raise SystemExit(0)
raise SystemExit(1)
PY
}

CRON_SECRET="$(read_env CRON_SECRET || true)"
if [[ -z "$CRON_SECRET" ]]; then
  echo ".env.local의 CRON_SECRET이 비어 있습니다." >&2
  exit 1
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "포트 $PORT가 이미 사용 중입니다. LOCAL_TEST_PORT=3118 npm run test:local 처럼 다른 포트를 사용하세요." >&2
  exit 1
fi

echo "[1/3] 로컬 Next 서버 시작: $BASE_URL"
NEXT_TELEMETRY_DISABLED=1 npm run dev -- --port "$PORT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [[ "$READY" != "1" ]]; then
  echo "로컬 서버 시작 실패. 로그:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "[2/3] health 확인 완료"

echo "[3/3] 현재 로컬 코드로 V4 Preview 전체 흐름 실행"
RESPONSE="$(curl --fail-with-body -sS \
  -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$BASE_URL/api/cron/daily?preview=v4")"

if ! printf '%s\n' "$RESPONSE" | python3 -m json.tool; then
  printf '%s\n' "$RESPONSE"
fi

echo
echo "성공: Vercel 배포를 기다리지 않고 현재 로컬 코드로 Firestore/Notion 전체 흐름을 검증했습니다."
echo "Notion에서 새 'V4 Preview' 페이지와 최소 속성 구성을 확인하세요."
