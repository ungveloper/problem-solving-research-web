# Notion 운영 DB 설정

이 프로젝트에서 **Notion은 명령을 내리는 화면**, **Firestore는 기억하고 판단하는 원본 DB**입니다.

## 1. 데이터베이스 생성

Notion에 `문제 해결 콘텐츠` 데이터베이스를 만들고 아래 속성을 추가합니다.

| 속성 | 타입 | 권장 값 |
| --- | --- | --- |
| 이름 | Title | 문제 제목 |
| 상태 | Status | 추천됨 / 진행 / 테스트 중 / 글쓰기 준비 / 작성 완료 / 발행 완료 / 보류 / 반려 |
| 카테고리 | Select | Mac, WordPress 등 |
| 세부 영역 | Select | 외장 디스플레이 등 |
| 유형 | Select | NEW / CONTINUE / UPDATE / EXPAND |
| 추천점수 | Number | 0~100 |
| Problem ID | Text | 시스템 표시용 |
| Mission ID | Text | 추후 Mission 연결용 |
| 연재 유형 | Select | ONE_SHOT / LIVING_LOG / SERIES |
| 현재 일차 | Number | 1부터 시작 |
| 관련 기존 글 | Text | 추후 자동 연결 |
| WordPress URL | URL | 발행 URL |
| 반려 이유 | Select | 중복 / 너무 흔함 / 관심 없음 / 직접 검증 불가 / 장비 없음 / 사이트 방향과 안 맞음 / 일회성 / 기타 |
| 반려 범위 | Select | EXACT / CLUSTER / SCOPE |
| 생성일 | Date | 자동 입력 |
| Firestore ID | Text | 동기화 키. 수정하지 않음 |
| Prompt Version | Text | 프롬프트 구성 버전 |

`이름`과 `상태`라는 속성명을 바꾸고 싶다면 각각 `NOTION_TITLE_PROPERTY`, `NOTION_STATUS_PROPERTY` 환경변수로 지정할 수 있습니다.

## 2. Integration 연결

1. Notion Integration을 생성합니다.
2. 위 데이터베이스를 Integration과 연결합니다.
3. Integration token을 `NOTION_API_KEY`에 저장합니다.
4. 데이터 소스 ID를 `NOTION_DATA_SOURCE_ID`에 저장합니다.

API 버전은 프로젝트에서 `2026-03-11`로 고정합니다.

## 3. 버튼

권장 버튼은 네 개입니다.

- `진행하기` → `상태 = 진행`
- `보류` → `상태 = 보류`
- `반려` → 필요하면 확인창 표시 후 `상태 = 반려`
- `작성 완료` → `상태 = 작성 완료`

반려 전에는 `반려 이유`, `반려 범위`를 선택합니다. `CLUSTER`가 기본적인 반려 범위입니다.

## 4. Webhook 자동화

Notion 유료 플랜의 Database Automation을 사용합니다.

- Trigger: `상태` 속성이 변경됨
- Action: `Send webhook`
- Method: POST
- URL: `https://<배포주소>/api/notion/webhook`
- Custom header:
  - Key: `X-Webhook-Secret`
  - Value: `NOTION_WEBHOOK_SECRET`와 동일한 비밀값

Webhook payload 자체는 신뢰하지 않습니다. webhook이 도착하면 서버가 Notion 데이터 소스를 다시 읽고 Firestore와 동기화합니다. 그래서 Notion 자동화의 payload 형식이 달라져도 상태 동기화가 깨지지 않습니다.

## 5. WordPress 발행 완료 처리

Notion에서 `작성 완료`는 `ARTICLE_READY` 상태입니다. 실제 WordPress 동기화에서 다음 중 하나가 확인되면 `발행 완료`로 승격됩니다.

1. `WordPress URL`이 실제 게시글 URL과 정확히 일치
2. 상태가 `작성 완료`이고 Problem 제목과 WordPress 제목이 정규화 후 정확히 일치

초기 버전은 잘못된 자동 매칭을 막기 위해 보수적으로 동작합니다. 이후 의미 기반 매칭을 추가할 수 있습니다.
