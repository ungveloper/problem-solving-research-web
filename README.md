# problem-solving-research-web

**문제 해결소**의 운영 도구입니다.

> Notion은 명령을 내리는 화면, Firestore는 기억하고 판단하는 뇌입니다. WordPress는 프롬프트/글 품질 검증 이후 연결합니다.

제품 방향과 장기 운영 원칙은 반드시 [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md)를 먼저 확인합니다.

## 현재 단계: PROMPT_VALIDATION

지금은 WordPress 서버/도메인 비용을 쓰지 않습니다.
매일 GitHub Actions가 Firestore의 상태를 읽어 ChatGPT Plus용 프롬프트를 생성하고, 같은 Notion 운영 DB에 새 페이지로 저장합니다.

```text
GitHub Actions (매일 08:00 KST)
        ↓
Notion 상태 → Firestore 동기화
        ↓
현재 Scope / 진행 중 Problem / 반려 기억 / 기존 글(있다면) 읽기
        ↓
상황별 Daily Prompt 구성
        ↓
Firestore dailyPrompts 저장
        ↓
Notion DAILY_RESEARCH 페이지 생성
        ↓
사용자가 Prompt를 ChatGPT Plus에 직접 붙여넣음
        ↓
웹 조사 → 후보 판단 → 직접 할 Mission
        ↓
사용자가 실제 Evidence를 제공하기 전에는 경험담 작성 금지
```

WordPress 환경변수가 비어 있어도 전체 daily flow는 정상 실행됩니다.

## 현재 들어간 것

- Firestore REST API 연결 (추가 Firebase npm 의존성 없음)
- Notion Data Source ↔ Firestore 상태 동기화
- Notion 상태 버튼 → Webhook → Firestore 재동기화
- `problems`, `rejections`, `dailyPrompts`, `siteProfiles`, `dailyRuns` 상태 기억
- 최초 실행 시 기본 주제 범위가 들어간 `siteProfiles/default` 생성
- 매일 하나의 `dailyPrompts/daily-YYYY-MM-DD` 생성 (동일 날짜 중복 방지)
- 진행 중 Problem이 있으면 `CONTINUATION_FIRST`, 없으면 `DISCOVERY`
- 동적 모듈형 프롬프트 구성
- 일일 Prompt → Notion `DAILY_RESEARCH` 페이지 자동 생성
- ChatGPT Plus가 최신 웹을 조사하도록 하는 초기 비용 0원 구조
- 반려 Problem은 향후 프롬프트의 반려 기억에 포함
- WordPress REST API 코드는 유지하지만 설정이 없으면 안전하게 skip
- WordPress 연결 이후 기존 글/카테고리 동기화 및 발행 완료 감지 가능
- 기본 관리자 대시보드

## 1. 필수 환경변수

### Firebase

```bash
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

서비스 계정 키 JSON 파일 자체는 저장소에 커밋하지 않습니다.

### Notion

`docs/notion-setup.md`에 맞춰 DB를 구성합니다.

```bash
NOTION_API_KEY=
NOTION_DATA_SOURCE_ID=
NOTION_WEBHOOK_SECRET=
NOTION_TITLE_PROPERTY=이름
NOTION_STATUS_PROPERTY=상태
```

특히 Notion `유형` Select에 `DAILY_RESEARCH`를 추가해야 합니다.

### 보호용 Secret

```bash
ADMIN_SECRET=<긴 랜덤 문자열>
CRON_SECRET=<긴 랜덤 문자열>
SITE_ID=default
```

`ADMIN_SECRET`은 수동 API 호출용, `CRON_SECRET`은 GitHub Actions용입니다.

## 2. WordPress는 현재 비워둡니다

현재 단계에서는 다음 값을 설정하지 않아도 됩니다.

```bash
WORDPRESS_BASE_URL=
WORDPRESS_USERNAME=
WORDPRESS_APPLICATION_PASSWORD=
```

값이 없으면 WordPress sync/publishing 단계는 정상적으로 skip됩니다.

프롬프트와 결과 글의 품질을 충분히 검증한 뒤 실제 WordPress를 연결합니다.

## 3. Vercel

GitHub 저장소를 Vercel에 배포하고 위 필수 환경변수를 등록합니다.

배포 후 확인:

```text
GET https://<배포주소>/api/health
```

Firestore/Notion이 `configured: true`, WordPress는 `required: false`, `deferred: true`이면 현재 단계에서 정상입니다.

## 4. GitHub Actions Secrets

Repository → Settings → Secrets and variables → Actions:

```text
APP_BASE_URL=https://배포된-vercel-주소
CRON_SECRET=Vercel의 CRON_SECRET과 동일
```

Workflow는 매일 08:00 KST에 `/api/cron/daily`를 호출합니다. `workflow_dispatch`로 수동 실행도 가능합니다.

## 5. 첫 일일 프롬프트 테스트

Actions를 기다리지 않고 즉시 테스트하려면:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  https://<배포주소>/api/prompts/daily
```

정상이라면:

1. Firestore `siteProfiles/default` 생성
2. Firestore `dailyPrompts/daily-YYYY-MM-DD` 생성
3. Notion `문제 해결 콘텐츠` DB에 `DAILY_RESEARCH` 페이지 생성
4. Notion 본문에 ChatGPT Plus용 프롬프트 생성

같은 날짜에 다시 호출해도 새 daily prompt 문서를 중복 생성하지 않습니다.

## 6. 일일 프롬프트가 하는 일

프롬프트는 단순 고정 템플릿 + 변수 치환이 아닙니다.
현재 상태에 따라 필요한 블록만 조합합니다.

- 진행 중 Problem 있음 → `CONTINUATION_FIRST`
- 없음 → `DISCOVERY`
- 활성 반려 기록 있음 → 반려 기억 블록 추가
- WordPress 글 있음 → 관련 기존 글 블록 추가
- WordPress 미연결 → 없는 기존 글을 추정하지 말라는 블록 사용

ChatGPT Plus에 붙여넣으면 최신 웹을 조사해서 최대 3개 후보를 보고, 최종 선택은 1개 이하로 제한합니다.
가치가 부족하면 `오늘은 진행할 신규 문제 없음`을 허용합니다.

최종 Evidence가 오기 전에는 블로그 글을 쓰지 않고 Mission에서 멈춥니다.

## 7. Notion 상태

실제 Problem 흐름:

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
(WordPress 연결 이후 실제 게시 확인)
  ↓
발행 완료
```

옆 상태로 `보류`, `반려`가 있습니다.
반려 시 Firestore `rejections`에 기억을 남깁니다.

## 8. API

- `GET /api/health` — 환경 연결 상태
- `POST /api/prompts/daily` — 오늘 프롬프트 즉시 생성/Notion 반영, `ADMIN_SECRET` 필요
- `POST /api/cron/daily` — GitHub Actions용 전체 일일 실행, `CRON_SECRET` 필요
- `POST /api/sync/notion` — Notion 수동 pull/push, `ADMIN_SECRET` 필요
- `POST /api/notion/webhook` — Notion Automation, `X-Webhook-Secret` 필요
- `POST /api/problems` — 실제 Problem 수동 생성, `ADMIN_SECRET` 필요
- `POST /api/sync/wordpress` — WordPress 연결 이후 사용

## 9. 다음 단계

Prompt Validation 단계에서 실제 ChatGPT Plus 결과를 보면서 다음을 먼저 튜닝합니다.

1. 일일 조사 프롬프트의 후보 품질
2. 중복/반려 회피 품질
3. Mission의 실제 수행 가능성
4. 연속성 판단 (`ONE_SHOT` / `LIVING_LOG` / `SERIES`)
5. Evidence를 받은 뒤 Natural Blog 글로 바꾸는 프롬프트

충분히 만족한 뒤에만:

6. WordPress 연결
7. 기존 글/카테고리 Coverage Map
8. `내 글들을 기반으로 다른 주제 추천받기`
9. 외부 Problem Collector
10. Search Console

자동 WordPress 발행은 기본 목표가 아닙니다.
