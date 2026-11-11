# problem-solving-research-web

**문제 해결소**의 운영 도구입니다.

> Notion은 명령을 내리는 화면, Firestore는 기억하고 판단하는 뇌, WordPress는 실제 발행 결과입니다.

초기 버전은 글을 자동 발행하지 않습니다. 기존 WordPress 글과 카테고리를 기억하고, 반려/보류/진행 상태를 Notion과 Firestore에서 동기화하며, ChatGPT Plus에 직접 넣을 문제 조사 프롬프트를 만드는 기반을 제공합니다.

## 현재 V1에 들어간 것

- WordPress REST API → Firestore `articles`, `categories` 동기화
- 기존 글 카테고리 보존
- Firestore REST API 연결 (추가 npm 의존성 없음)
- Notion Data Source → Firestore 상태 동기화
- Firestore Problem → Notion 페이지 생성
- Notion 상태 버튼 → Webhook → Firestore 재동기화
- 반려 시 `rejections` 기억 생성
- 문제 후보 생성 시 기존 WordPress 글 + 반려 기억을 조합한 ChatGPT Plus용 프롬프트 생성
- `작성 완료` Problem이 실제 WordPress 글로 확인되면 `발행 완료`로 자동 승격
- GitHub Actions 매일 08:00 KST 동기화
- 기본 관리자 대시보드

## 1. Firebase

Firestore Standard를 만든 뒤 서버용 Service Account를 준비합니다.

Vercel 환경변수:

```bash
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

서비스 계정 키 JSON 파일 자체는 저장소에 커밋하지 않습니다.

이 프로젝트는 패키지 추가 없이 Firestore 공식 REST API를 사용합니다. 서버는 Service Account로 Google OAuth 토큰을 발급받아 `datastore` scope로 호출합니다.

## 2. Notion

`docs/notion-setup.md`를 먼저 따라 데이터베이스를 만듭니다.

```bash
NOTION_API_KEY=
NOTION_DATA_SOURCE_ID=
NOTION_WEBHOOK_SECRET=
```

Notion의 `Firestore ID` 속성은 동기화 키이므로 직접 수정하지 않습니다.

## 3. WordPress

공개 게시글만 동기화한다면 대부분 URL만 필요합니다.

```bash
WORDPRESS_BASE_URL=https://your-blog.com
```

인증이 필요한 경우에만 추가합니다.

```bash
WORDPRESS_USERNAME=
WORDPRESS_APPLICATION_PASSWORD=
```

## 4. 보호용 비밀값

```bash
ADMIN_SECRET=<긴 랜덤 문자열>
CRON_SECRET=<긴 랜덤 문자열>
```

`ADMIN_SECRET`은 수동 API 호출용, `CRON_SECRET`은 GitHub Actions용입니다.

## 5. GitHub Actions Secrets

Repository → Settings → Secrets and variables → Actions에 추가합니다.

```text
APP_BASE_URL=https://배포된-vercel-주소
CRON_SECRET=Vercel의 CRON_SECRET과 동일
```

Workflow는 매일 08:00 KST에 `/api/cron/daily`를 호출합니다. `workflow_dispatch`로 수동 실행도 가능합니다.

## 6. 첫 WordPress 동기화

배포 후:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  https://배포주소/api/sync/wordpress
```

정상 동작하면 Firestore에 `categories`, `articles`가 생기고 대시보드에 기존 글이 표시됩니다.

## 7. 첫 Problem 테스트

아직 외부 주제 수집기를 붙이기 전이므로 테스트 후보를 수동으로 넣습니다.

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Mac 잠자기 후 외장모니터가 다시 켜지지 않는 문제",
    "category":"Mac",
    "detailArea":"외장 디스플레이",
    "whyRecommended":"직접 재현하고 연결 조건을 비교할 수 있는 Evergreen 문제",
    "score":88,
    "mode":"NEW",
    "storyMode":"LIVING_LOG"
  }' \
  https://배포주소/api/problems
```

이 요청은 다음을 수행합니다.

1. Firestore의 기존 WordPress 글과 활성 반려 기록을 읽음
2. 상황에 맞는 `research-v1` 프롬프트 생성
3. `problems`에 저장
4. Notion 데이터베이스에 새 페이지 생성
5. Notion 본문에 ChatGPT Plus용 프롬프트를 코드 블록으로 기록

## 8. 상태 흐름

```text
추천됨
  ↓
진행
  ↓
테스트 중
  ↓
글쓰기 준비
  ↓
작성 완료
  ↓
WordPress Sync에서 실제 게시 확인
  ↓
발행 완료
```

옆 상태로 `보류`, `반려`가 있습니다.

반려 시 Firestore `rejections`에 기억을 남깁니다. 다시 진행 상태로 바꾸면 해당 반려 기록은 비활성화됩니다.

## 9. API

- `GET /api/health` — 환경 연결 상태 (비밀값은 반환하지 않음)
- `POST /api/sync/wordpress` — WordPress 수동 동기화, `ADMIN_SECRET` 필요
- `POST /api/sync/notion` — Notion 수동 pull/push, `ADMIN_SECRET` 필요
- `POST /api/notion/webhook` — Notion Automation 전용, `X-Webhook-Secret` 필요
- `POST /api/problems` — 테스트/수동 Problem 생성, `ADMIN_SECRET` 필요
- `POST /api/cron/daily` — 매일 통합 동기화, `CRON_SECRET` 필요

## 다음 구현 순서

V1 연결이 실제 데이터로 검증되면 다음 순서로 확장합니다.

1. Mission / Evidence 입력 UI
2. 카테고리 Coverage Map
3. EXACT / CLUSTER / SCOPE 반려 필터 강화
4. `내 글들을 기반으로 다른 주제 추천받기` (`EXPAND_SCOPE`)
5. 외부 Problem Collector 1개 연결
6. Search Console 연결
7. Mission 결과 기반 Natural Blog 글쓰기 프롬프트

처음부터 자동 글 작성/자동 WordPress 발행은 넣지 않습니다.
