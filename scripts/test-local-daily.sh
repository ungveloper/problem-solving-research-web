#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ungveloper/Desktop/UNG/problem-solving-research-web"
ENV_FILE="$ROOT/.env.local"
PREFERRED_PORT="${LOCAL_TEST_PORT:-3117}"
LOG_FILE="${TMPDIR:-/tmp}/problem-solving-research-local-${PREFERRED_PORT}-$$.log"
SERVER_PID=""
BASE_URL=""

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
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

server_for_port() {
  local port="$1"
  local pid cwd
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -n "$pid" ]] || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  [[ "$cwd" == "$ROOT" ]] || return 1
  curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 || return 1
  printf '%s' "$port"
}

find_existing_server() {
  local port found
  for port in $(seq 3000 3020) $(seq 3117 3130); do
    found="$(server_for_port "$port" || true)"
    if [[ -n "$found" ]]; then
      printf '%s' "$found"
      return 0
    fi
  done

  # Next.js 16의 dev lock이 가리키는 프로세스가 일반 범위 밖 포트를 쓸 수 있어
  # 같은 cwd의 next 프로세스가 연 LISTEN 포트도 한 번 더 확인한다.
  local pid cwd cmd p
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    [[ "$cwd" == "$ROOT" ]] || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$cmd" == *next* || "$cmd" == *"npm run dev"* ]] || continue
    while read -r p; do
      [[ -n "$p" ]] || continue
      if curl -fsS "http://127.0.0.1:${p}/api/health" >/dev/null 2>&1; then
        printf '%s' "$p"
        return 0
      fi
    done < <(lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | sed -nE 's/.*:([0-9]+) \(LISTEN\)$/\1/p' | sort -u)
  done < <(pgrep -f 'next dev|next-server|npm run dev' 2>/dev/null || true)
  return 1
}

EXISTING_PORT="$(find_existing_server || true)"
if [[ -n "$EXISTING_PORT" ]]; then
  BASE_URL="http://127.0.0.1:${EXISTING_PORT}"
  echo "[1/3] 기존 로컬 Next 서버 재사용: $BASE_URL"
else
  PORT="$PREFERRED_PORT"
  while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    if (( PORT > PREFERRED_PORT + 20 )); then
      echo "사용 가능한 로컬 테스트 포트를 찾지 못했습니다." >&2
      exit 1
    fi
  done
  BASE_URL="http://127.0.0.1:${PORT}"
  echo "[1/3] 임시 로컬 Next 서버 시작: $BASE_URL"
  NEXT_TELEMETRY_DISABLED=1 npm run dev -- --port "$PORT" >"$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  READY=0
  for _ in $(seq 1 80); do
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
    tail -100 "$LOG_FILE" >&2 || true
    exit 1
  fi
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
echo "성공: 현재 로컬 코드로 Firestore/Notion 전체 흐름을 검증했습니다."
if [[ -n "$EXISTING_PORT" ]]; then
  echo "기존 개발 서버는 종료하지 않았습니다."
else
  echo "테스트가 시작한 임시 개발 서버는 자동 종료합니다."
fi
echo "Notion에서 새 'V4 Preview' 페이지, '생성 일시' 속성, 최소 속성 구성을 확인하세요."
