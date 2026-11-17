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
웹 조사 → 후보 판단 → 내부 행동 시나리오
        ↓
1인칭 체험형 블로그 초안 작성 (미확인 결과는 확정 금지)
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

V5.11부터 Daily Research는 넓은 웹 탐색 뒤 최종 Problem 0~1개를 고르고, 내부적으로 행동 시나리오를 설계한 뒤 **블로그 본문에서는 그 행동을 화자 `나`의 1인칭 체험형 서술로 바꿔 같은 응답에서 초안까지 작성합니다.** 이 1인칭 체험감은 이후의 편집·압축·이미지 계획보다 우선하는 고정 아이덴티티입니다. 여기에 Evidence 범위 가드를 추가해 Python/코드에서 확인한 결과를 Mac·Windows 실제 GUI에서 재현한 것처럼 확대하지 않고, 제목·H2·마지막 판단도 실제 확인 범위에 맞춥니다. 직접 테스트 결과가 생기면 별도 결과 보고서 섹션으로 반복하지 않고 블로그 본문 안의 해당 장면에 통합합니다. 이미지가 실제로 필요하면 이미지 계획뿐 아니라 **본문 안의 정확한 삽입 지점에도 같은 번호의 마커를 표시**합니다. 아직 확인되지 않은 성공·실패·오류·해결 결과는 지어내지 않습니다. 실제 결과가 들어오면 초안을 실제 사건 흐름에 맞게 다시 구성하고 `WRITE / RECORD_ONLY`와 Story Shape를 판단합니다. Notion의 생성 시각은 별도 Date 값 대신 기본 `생성 일시`(Created time)를 사용합니다.

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

## Daily Prompt V2 탐색 방식

V2부터 `Mac / Windows / PDF ...` 목록은 고정 허용 범위가 아니라 참고 앵커로만 사용합니다.
ChatGPT Plus는 먼저 여러 영역에서 10~15개의 Problem Territory를 넓게 탐색하고, 실제 웹 반복 신호를 확인한 5개 이하를 비교한 뒤 최종 Problem을 최대 1개 선택합니다.

최종 Problem을 고른 뒤에도 글 형식이나 Story Shape를 미리 정하지 않습니다. 오늘 어떤 행동으로 새로운 Evidence를 만들지에 대한 검증 관점 하나만 고르고, 실제 사용자가 그대로 할 수 있는 최소 행동과 Story Seed를 남깁니다.

오늘 이미 V1 프롬프트를 생성한 상태에서 V2를 별도로 비교하려면:

```bash
curl --fail-with-body -sS \\
  -X POST \\
  -H "Authorization: Bearer $ADMIN_SECRET" \\
  "${APP_BASE_URL%/}/api/prompts/daily?preview=v2"
```

이 호출은 `daily-YYYY-MM-DD-v2-preview` 문서를 별도로 만들어 기존 오늘 프롬프트를 덮어쓰지 않습니다.
내일부터 일반 GitHub Actions 실행은 자동으로 V2 프롬프트를 생성합니다.

## Daily Prompt V3 — 선택 결과를 다음 조사에 기억시키기

V3부터 Daily Prompt는 답변 맨 마지막에 `PROBLEM_MEMORY_JSON`을 출력하도록 지시합니다.
Notion 데이터 소스에는 API가 다음 두 속성을 자동으로 추가합니다.

```text
선택 결과 JSON  — Rich text
결과 반영       — Checkbox
```

ChatGPT Plus 결과를 확인한 뒤 마지막 JSON만 `선택 결과 JSON`에 붙여넣고 `결과 반영`을 체크합니다.
다음 GitHub Action 실행 시:

```text
Notion 선택 결과
→ Firestore dailyPrompts 기록
→ NEW면 problems에 IN_PROGRESS Problem 생성
→ CONTINUE면 기존 Problem ID에 연결
→ Problem ID를 Notion에 기록
→ 다음 Daily Prompt의 Problem 기억 인덱스에 포함
```

수동 `Run workflow`는 테스트를 위해 매번 새 `V5 Preview`를 생성합니다.
정기 스케줄 실행은 기존처럼 하루에 하나의 일반 Daily Prompt만 생성합니다.

`NEW` 결과 JSON 예시:

```json
{
  "decision": "NEW",
  "title": "Google Keep 메모가 PC에 늦게 반영되는 문제",
  "category": "메모·생산성",
  "detailArea": "다중 기기 동기화",
  "concept": "A/B 조건별 동기화 시간 비교",
  "whyRecommended": "서로 다른 시점의 반복 보고가 있고 일반 기기로 직접 검증 가능",
  "missionSummary": "편집 화면 유지, 목록 복귀, 수동 동기화 조건에서 PC 반영 시간을 비교",
  "storyMode": "ONE_SHOT"
}
```


## 로컬 즉시 테스트

Vercel 재배포를 기다리지 않고 현재 로컬 코드로 전체 일일 흐름을 바로 검증할 수 있습니다.

```bash
cd /Users/ungveloper/Desktop/UNG/problem-solving-research-web
npm run test:local
```

`.env.local`의 `CRON_SECRET`을 자동으로 읽으며 별도로 비밀값을 붙여넣지 않습니다.
임시 로컬 Next 서버를 시작한 뒤 `/api/cron/daily?preview=v5`를 호출하고 자동 종료합니다.
이 테스트는 실제 Firestore/Notion을 사용하므로 V5 Preview와 스키마 정리가 실제 DB에 반영됩니다.

## Notion 최소 속성

현재 단계에서는 필요한 속성만 유지합니다.

```text
이름
상태
유형
생성 일시
Firestore ID
선택 결과 JSON
결과 반영
반려 이유
반려 범위
```

기존의 카테고리, 세부 영역, 추천점수, Problem ID, Mission ID, 연재 유형, 현재 일차, 관련 기존 글, WordPress URL, Prompt Version 및 상태 변경용 버튼 열은 다음 동기화 시 제거됩니다. 상세 메타데이터는 Firestore에 계속 보존합니다.

## Daily Research V5 — 실제 경험이 글의 형태를 결정

V5.15의 핵심은 **V5.14의 Signal-first 탐색과 중복 방지 알고리즘을 유지하면서, 매일 05:00 KST 1회 실행하고 결과를 auto-publisher-web에 그대로 복사/붙여넣을 수 있는 WordPress 게시 패키지와 대표 썸네일 프롬프트까지 함께 출력하는 것**입니다.

```text
Broad Discovery
→ 기존 Problem/반려/발행 기억과 중복 검사
→ 오늘 직접 확인할 Problem 0~1개
→ 검증 관점 1개
→ 내부 행동 시나리오 설계
→ 화자 나의 1인칭 체험형 블로그 초안 작성
→ 중복·늘어짐·마무리 자체 편집(1인칭 체험감 보존)
→ Evidence 범위 점검 + 직접 결과를 본문에 통합
→ 필요한 이미지 계획 + 본문 삽입 마커(실제 캡처 / 생성 이미지 구분)
→ 실제 관찰 결과 확보
→ Evidence 분류 + 초안 재구성
→ WRITE / RECORD_ONLY
→ WRITE면 실제 결과에 맞는 Story Shape 선택
→ 최종 Natural Blog
```

Daily Research는 내부적으로 넓게 탐색하지만 10~15개 Territory 전체를 긴 보고서로 출력하지 않습니다. 응답의 중심은 자연스러운 개인 블로그 초안이며, 내부 행동 시나리오는 실제 경험을 해본 사람의 1인칭 목소리로 바뀝니다. 압축·구조 수정이 들어와도 이 체험감을 일반 가이드 말투로 바꾸지 않습니다. 블로그 본문에는 목표 글자 수나 최소·최대 분량이 없고, H2/H3 개수·문단 수·도입 방식·전개 순서·결론 유무·마지막 문장 역할·이미지 수도 고정하지 않습니다. 짧게 끝날 경험은 짧게, 시행착오가 많은 경험은 길게 쓰며, 같은 주제군이라도 이전 글의 구조를 복제하지 않습니다. 특히 글의 분량은 리서치 자료량이 아니라 실제 OBSERVED 경험량에 맞춥니다. 공식 문서를 읽은 것은 '문서를 확인해봤다'는 경험으로 쓰되, 그 문서의 절차를 직접 실행한 것처럼 장문 사용법으로 확장하지 않습니다. 직접 앱·파일·브라우저를 충분히 만져보지 않았다면 짧은 확인 기록으로 끝나도 정상입니다. 본문과 이미지 계획은 일반 Markdown만 사용하며 서식용 HTML/JSX/MDX 태그를 출력하지 않습니다. 실제로 제공되지 않은 파일을 첨부·다운로드 가능한 것처럼 쓰지 않고, 이미지 계획에 검색 중 발견한 외부 참고 이미지나 썸네일을 넣지 않습니다. Python/파일 도구에서 직접 얻은 Evidence는 확인한 환경을 명시하고 제목·H2·결론을 그 범위보다 넓게 쓰지 않습니다. 직접 결과는 별도 상위 보고서 섹션으로 반복하지 않고 블로그 본문 안에 한 번만 녹입니다. 이미지가 필요하면 실제 Evidence 캡처와 설명용 생성 이미지를 구분해 제안하고, 본문 안에도 `[이미지 N 삽입: 설명 — 종류]` 마커를 정확한 위치에 표시합니다. 아직 실제로 확인되지 않은 성공·실패·오류·해결 결과만 확정하지 않습니다.

최종 글은 Daily Research의 후보 순위나 Evidence 표를 목차로 복사하지 않습니다. 실제로 벌어진 사건의 순서와 예상 밖 결과가 글 구조를 결정하며, 짧은 해결은 짧게 끝내고 실패나 미해결도 독자 가치가 있으면 그대로 기록할 수 있습니다.

Daily Research의 사용자용 출력은 `1. 오늘의 판단`부터 `5. 실제 관찰 후 업데이트할 포인트`까지만 번호를 사용합니다. Firestore 반영용 `PROBLEM_MEMORY_JSON`은 블로그 콘텐츠가 아니므로 `6.` 섹션으로 표시하지 않습니다. 대신 응답 맨 마지막에 `---` 수평선 뒤 `운영용 데이터 — WordPress에 복사하지 않음`으로 완전히 분리하고, 그 아래 JSON 코드 블록만 둡니다.

## WordPress 직접 발행 자동 추적

WordPress 연결 후에는 자동 발행하지 않습니다. 사용자가 WordPress에서 평소처럼 직접 글을 발행하면 다음 Daily Sync 또는 `POST /api/sync/wordpress`가 게시글을 가져와 Firestore `articles`에 동기화합니다.

Problem과 게시글 연결은 URL 정확 일치 → 제목 정확 일치 → 고신뢰 내용 매칭 순서로 수행합니다. 내용 매칭은 Problem의 제목·세부 영역·검증 관점·Mission·Story Seed와 WordPress 글의 제목·카테고리·본문을 비교하며, 최근성 조건과 후보 간 점수 차이를 함께 확인합니다. 애매하면 자동 연결하지 않습니다.

고신뢰로 연결되면 해당 Problem은 자동으로 `PUBLISHED`가 되고 다음 값이 Firestore에 기록됩니다.

```text
wordpressUrl
linkedArticleId
publicationMatchMethod  # URL / TITLE / CONTENT
publicationMatchScore
publishedDetectedAt
```

따라서 `PROBLEM_MEMORY_JSON`이 먼저 Firestore Problem으로 반영되어 있다는 전제에서, WordPress ENV 연결 후에는 최종 글 제목을 자유롭게 정해 직접 발행하기만 하면 대부분의 발행 이력은 다음 동기화에서 자동 관리됩니다.

## Daily Research 중복 방지와 상태 변화

같은 주제를 제목만 바꾸어 NEW로 반복하지 않도록 두 겹으로 막습니다.

- Daily Prompt에는 기존 Problem의 압축 중복 인덱스와 최근 상세 기억을 함께 넣습니다.
- `PROBLEM_MEMORY_JSON`을 반영할 때 서버가 `title + detailArea + concept + missionSummary + storySeed`를 다시 비교합니다.

고신뢰 중복이면 새 `problems` 문서를 만들지 않고 해당 Daily Research를 `보류`로 처리하며 기존 Problem ID와 중복 점수를 기록합니다.

Notion 상태는 다음처럼 움직입니다.

```text
DAILY_RESEARCH 생성
추천됨
  ↓ JSON 객체 붙여넣기 + 결과 반영
정상 NEW / CONTINUE → DAILY_RESEARCH: 작성 완료
중복 차단 / HOLD / NO_GO → DAILY_RESEARCH: 보류

NEW가 정상 반영되면 별도 Problem 행 생성
Problem: 진행
  ↓ 실제 검증/운영
테스트 중 → 글쓰기 준비 → 작성 완료
  ↓ WordPress 실제 게시 감지
발행 완료
```

따라서 DAILY_RESEARCH 행과 Problem 행은 서로 다른 기록입니다. Daily Research는 조사 세션의 처리 여부를 나타내고, Problem 행은 실제 주제의 수명주기를 나타냅니다.

사용자가 매일 수동으로 하는 작업은:
1. Daily Prompt를 ChatGPT Plus에 붙여넣기
2. 답변 마지막 JSON 코드 블록에서 `{ ... }` 객체만 `선택 결과 JSON`에 붙여넣기
3. `결과 반영` 체크
4. 발행할 최종 글을 WordPress에 직접 게시

WordPress 연결 이후의 게시글 수집, Firestore `articles` 저장, Problem 자동 연결, `PUBLISHED`, Notion `발행 완료` 처리는 동기화가 담당합니다.

## Signal-first Discovery

V5.14부터 Daily Research는 기존 `activeScopes`에서 주제를 고르는 방식이 아니라 외부 수요 신호에서 출발합니다.

```text
Google Trends / Naver 검색·DataLab / 커뮤니티 / 공식 변화
→ 오늘의 Signal
→ 실제 사용자 Problem으로 변환
→ 기존 Firestore Problem과 중복 제거
→ 직접 검증 가능한 후보만 남김
→ 최종 0~1개
```

기존 `activeScopes`는 약 10~15%의 Evergreen 보조 앵커로만 사용합니다. 과거 기본값인 Mac/iPhone/Windows/PDF/Excel 중심 목록은 사용자가 수정하지 않은 기본 프로필에 한해 로그인·인증, 결제·예약, 사진·영상, 문서·파일, 백업·복구, 메신저·알림, 지도·이동, 스트리밍, 스마트기기, 공공서비스 등 행동 중심 Scope로 자동 마이그레이션됩니다.

Google Trends나 Naver DataLab의 관심도는 높은 검색량 자체를 글 선정 기준으로 쓰지 않습니다. 새로운 문제 영역을 발견하거나 비슷한 후보의 우선순위를 정하는 보조 신호로만 사용하고, 반복 불편·직접 검증 가능성·새 Evidence 가치가 최종 판단을 이깁니다.

현재 단계에서는 새로운 API 키가 필요 없습니다. ChatGPT Plus의 웹 조사 단계에서 이 신호를 사용합니다. Naver Search Trend API는 NAVER API HUB 이관 중이므로, 나중에 서버가 데이터를 직접 수집할 필요가 생기면 optional collector와 ENV를 별도로 추가합니다.

## 05:00 KST Daily Sync + auto-publisher-web 복붙 호환

정기 GitHub Actions는 하루 1회 `05:00 Asia/Seoul`에 실행합니다. cron은 전날 `20:00 UTC`인 `0 20 * * *`입니다.

V5.15부터 NEW/CONTINUE 결과에는 `auto-publisher-web`의 `/wordpress` 페이지가 그대로 인식하는 게시 패키지가 포함됩니다. 응답 전체를 복사해 붙여넣어도 퍼블리셔가 `# 1. 게시용 본문`을 WordPress 본문으로 추출하고, `# 4. Rank Math SEO 패키지`에서 다음 값을 자동으로 채울 수 있게 합니다.

- 게시 제목: `# 1. 게시용 본문` 안의 실제 H1
- 포커스 키워드
- SEO Title
- 영문 퍼머링크
- SEO Description
- 카테고리
- 태그

메타데이터는 기존 `auto-publisher-web` 파서와 맞추기 위해 `포커스 키워드`, `SEO title`, `영문 퍼머링크`, `SEO description`, `글 태그`, `카테고리명` 라벨을 그대로 사용하고 값은 fenced code block으로 출력합니다.

`# 3. 대표 이미지 생성 프롬프트`에는 첨부 예시 계열의 썸네일을 만들 수 있는 복사/붙여넣기용 프롬프트가 포함됩니다. 주제에 맞는 배경 위에 반투명 로열블루 오버레이를 씌우고, 작은 흰색 카테고리 pill과 굵은 흰색 한글 핵심 문구를 배치하며 우측 상단은 실제 로고 삽입 공간으로 비워둡니다.

`auto-publisher-web` 자체는 이미 이 구조를 처리하므로 이번 변경에서는 해당 저장소의 파싱 알고리즘을 수정하지 않습니다.
