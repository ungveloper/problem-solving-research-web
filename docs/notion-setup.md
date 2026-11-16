# Notion 운영 DB 설정 — 최소 스키마

Notion은 운영 UI이고, 상세 메타데이터와 중복 판단의 원본은 Firestore입니다.
현재 Prompt Validation 단계에서는 열을 최소화합니다.

## 유지하는 속성

| 속성 | 타입 | 용도 |
| --- | --- | --- |
| 이름 | Title | Daily Research 또는 Problem 제목 |
| 상태 | Status | 추천됨 / 진행 / 테스트 중 / 글쓰기 준비 / 작성 완료 / 발행 완료 / 보류 / 반려 |
| 유형 | Select | DAILY_RESEARCH / NEW / CONTINUE / UPDATE / EXPAND |
| 생성 일시 | Created time | Notion이 행 생성 시각을 자동 기록 |
| Firestore ID | Text | 시스템 동기화 키. 직접 수정하지 않음 |
| 선택 결과 JSON | Text | ChatGPT 답변 마지막의 PROBLEM_MEMORY_JSON 붙여넣기 |
| 결과 반영 | Checkbox | 체크하면 다음 동기화에서 Firestore Problem 기억으로 반영 |
| 반려 이유 | Select | 반려 기억의 이유 |
| 반려 범위 | Select | EXACT / CLUSTER / SCOPE |

`Firestore ID`는 시스템용이므로 일반 뷰에서 숨겨도 됩니다. `생성 일시`는 Notion 기본 Created time 속성이므로 애플리케이션이 날짜 값을 직접 쓰지 않습니다.

## 자동 제거되는 기존 속성

다음 속성은 현재 단계에서 Notion에 둘 필요가 없어 다음 동기화 때 제거합니다.

- 생성일
- 카테고리
- 세부 영역
- 추천점수
- Problem ID
- Mission ID
- 연재 유형
- 현재 일차
- 관련 기존 글
- WordPress URL
- Prompt Version
- 진행하기 / 보류 / 반려 / 작성 완료 버튼 열

이 정보가 필요한 경우 Firestore에는 계속 보존되며, 제품 단계가 커지면 필요한 열만 다시 추가합니다.

## Daily Research 사용 흐름

1. Daily Research 페이지의 프롬프트를 ChatGPT Plus에 입력합니다.
2. ChatGPT는 조사 → Problem 선택 → Mission → 최소 Evidence → **검증 전 블로그 초안** → `PROBLEM_MEMORY_JSON` 순서로 답합니다.
3. 마지막 JSON만 `선택 결과 JSON`에 붙여넣습니다.
4. `결과 반영`을 체크합니다.
5. 다음 로컬 테스트/Action/Webhook 동기화가 Firestore Problem 기억으로 반영합니다.
6. `NEW`는 진행 중 Problem이 되고, 이후 Daily Prompt는 같은 문제를 다시 NEW로 만들지 않고 CONTINUE/HOLD 여부를 먼저 판단합니다.

## 검증 전 블로그 초안

Evidence 전에도 실제 본문 형태의 초안을 만듭니다. 다만 직접 수행하지 않은 결과는 확정하지 않습니다.
실험이 필요한 부분은 미확정으로 표시하고, 실제 결과가 들어오면 해당 부분을 OBSERVED로 교체해 최종 글로 다듬습니다.

## 로컬 즉시 테스트

Vercel 배포를 기다리지 않아도 됩니다.

```bash
cd /Users/ungveloper/Desktop/UNG/problem-solving-research-web
npm run test:local
```

이 명령은 `.env.local`을 읽어 임시 로컬 Next 서버를 실행하고 실제 Firestore/Notion에 V4 Preview 전체 흐름을 호출한 뒤 자동 종료합니다.
