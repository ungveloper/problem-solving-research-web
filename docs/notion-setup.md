# Notion 운영 DB 설정

이 프로젝트에서 **Notion은 명령을 내리는 화면**, **Firestore는 기억하고 판단하는 원본 DB**입니다.
현재는 WordPress를 연결하지 않고 일일 프롬프트 품질을 먼저 검증합니다.

## 1. 데이터베이스 구조

Notion의 `문제 해결 콘텐츠` 데이터베이스에 아래 속성을 둡니다.

| 속성 | 타입 | 권장 값 |
| --- | --- | --- |
| 이름 | Title | 문제 제목 또는 일일 프롬프트 제목 |
| 상태 | Status | 추천됨 / 진행 / 테스트 중 / 글쓰기 준비 / 작성 완료 / 발행 완료 / 보류 / 반려 |
| 카테고리 | Select | Mac, WordPress 등 |
| 세부 영역 | Select | 외장 디스플레이 등 |
| 유형 | Select | **DAILY_RESEARCH** / NEW / CONTINUE / UPDATE / EXPAND |
| 추천점수 | Number | 0~100 |
| Problem ID | Text | 실제 Problem의 시스템 표시용 |
| Mission ID | Text | 추후 Mission 연결용 |
| 연재 유형 | Select | ONE_SHOT / LIVING_LOG / SERIES |
| 현재 일차 | Number | 1부터 시작 |
| 관련 기존 글 | Text | 관련성/연속성 메모 |
| WordPress URL | URL | WordPress 연결 이후 발행 URL |
| 반려 이유 | Select | 중복 / 너무 흔함 / 관심 없음 / 직접 검증 불가 / 장비 없음 / 사이트 방향과 안 맞음 / 일회성 / 기타 |
| 반려 범위 | Select | EXACT / CLUSTER / SCOPE |
| 생성일 | Date | 자동 입력 |
| Firestore ID | Text | 동기화 키. 직접 수정하지 않음 |
| Prompt Version | Text | 프롬프트 구성 버전 |

### 상태 그룹 권장 배치

- 시작 전: `추천됨`, `보류`
- 진행 중: `진행`, `테스트 중`, `글쓰기 준비`, `작성 완료`
- 완료: `발행 완료`, `반려`

### `유형`에 반드시 추가할 값

현재 일일 자동 프롬프트를 같은 DB에 저장하므로 `유형` Select에 아래 옵션을 추가합니다.

```text
DAILY_RESEARCH
NEW
CONTINUE
UPDATE
EXPAND
```

`DAILY_RESEARCH` 행은 실제 글감 자체가 아니라 **그날 ChatGPT Plus에 붙여넣을 조사 세션 프롬프트**입니다.

## 2. Integration 연결

1. Notion API 토큰 방식의 연결 `문제해결소`를 생성합니다.
2. 권한은 콘텐츠 읽기 / 업데이트 / 삽입만 켭니다.
3. 사용자 정보, 댓글, 에이전트 권한은 끕니다.
4. `문제 해결 콘텐츠` 데이터베이스 페이지에 `문제해결소` 연결을 추가합니다.
5. API token을 `NOTION_API_KEY`에 저장합니다.
6. 데이터 소스 ID를 `NOTION_DATA_SOURCE_ID`에 저장합니다.

API 버전은 프로젝트에서 `2026-03-11`로 고정합니다.

## 3. 버튼

실제 Problem 행에서 사용하는 권장 버튼:

- `진행하기` → `상태 = 진행`
- `보류` → `상태 = 보류`
- `반려` → 필요하면 확인창 표시 후 `상태 = 반려`
- `작성 완료` → `상태 = 작성 완료`

반려 전에는 `반려 이유`, `반려 범위`를 선택합니다. `CLUSTER`를 기본 범위로 권장합니다.

일일 `DAILY_RESEARCH` 페이지는 주로 프롬프트 복사용입니다. 상태 버튼을 눌러도 Firestore의 `dailyPrompts` 상태에만 반영되며 반려 Problem 기억으로 등록되지는 않습니다.

## 4. Webhook 자동화

Notion 유료 플랜의 Database Automation을 사용합니다.

- Trigger: `상태` 속성이 변경됨
- Action: `Send webhook`
- Method: POST
- URL: `https://<배포주소>/api/notion/webhook`
- Custom header:
  - Key: `X-Webhook-Secret`
  - Value: `NOTION_WEBHOOK_SECRET`와 동일한 비밀값

Webhook payload 자체를 원본으로 신뢰하지 않습니다. webhook이 도착하면 서버가 Notion Data Source를 다시 읽고 Firestore와 동기화합니다.

## 5. 일일 프롬프트 페이지

GitHub Actions가 매일 08:00 KST에 실행되면 같은 데이터베이스에 아래와 같은 페이지가 생깁니다.

```text
2026-11-17 오늘의 문제 조사 프롬프트
유형: DAILY_RESEARCH
상태: 추천됨
```

페이지 본문의 `ChatGPT Plus에 그대로 붙여넣기` 아래 코드 블록 전체를 복사해 ChatGPT Plus에 입력합니다.

- 진행 중 Problem이 있으면 `CONTINUATION_FIRST`
- 없으면 `DISCOVERY`

모드에 따라 프롬프트의 실제 구성도 달라집니다.

## 6. WordPress는 현재 선택 사항

현재 `PROMPT_VALIDATION` 단계에서는 WordPress 관련 속성은 만들어두기만 하고 비워둡니다.
프롬프트 품질 검증이 끝난 뒤 WordPress를 연결하면 `WordPress URL`과 `발행 완료` 자동 승격 기능을 사용합니다.
