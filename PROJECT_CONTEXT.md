# 문제 해결소 — 제품 운영 계약

이 문서는 `problem-solving-research-web`의 장기 방향을 고정하는 제품 컨텍스트입니다.
코드나 자동화 로직을 변경할 때 README보다 먼저 이 문서를 확인합니다.

## 서비스 정체성

문제 해결소는 AI가 SEO 글을 대량 생성하는 도구가 아닙니다.

> AI가 매일 해결할 만한 문제를 찾고 미션을 설계하며, 사람이 직접 확인한 결과를 자연스러운 개인 블로그 글로 발전시키는 운영 시스템입니다.

- Notion: 사람이 명령을 내리고 프롬프트를 확인하는 운영 콘솔
- Firestore: 문제, 반려, 진행 상태, 프롬프트, 향후 글 이력을 기억하는 원본 DB
- ChatGPT Plus: 사용자가 생성된 프롬프트를 직접 붙여넣어 조사/미션 설계/글쓰기 품질을 검증하는 단계
- WordPress: 최종 발행 결과. 초기 검증 단계에서는 연결하지 않아도 됨

## 현재 단계 — PROMPT_VALIDATION

현재는 WordPress 서버비/도메인비를 쓰지 않는다.
WordPress 연동 코드는 유지하되 `WORDPRESS_BASE_URL`이 없으면 모든 WordPress 동작을 안전하게 건너뛴다.

우선순위는 다음과 같다.

1. Vercel 배포
2. GitHub Actions 매일 08:00 KST 실행
3. Firestore의 운영 상태를 읽어 일일 ChatGPT Plus용 프롬프트 생성
4. 생성 프롬프트를 같은 Notion 운영 DB에 저장
5. 사용자가 프롬프트를 ChatGPT Plus에 직접 붙여넣음
6. 결과와 글 품질을 검토하면서 프롬프트/판단 로직 개선
7. 충분히 만족한 뒤 WordPress를 연결하고 기존 글 동기화 및 발행 완료 감지를 활성화

## 일일 프롬프트 원칙

고정 템플릿에 변수만 바꾸는 방식으로 운용하지 않는다.
Prompt Composer는 현재 상태에 따라 모듈을 선택한다.

- 진행 중 Problem이 있으면 `CONTINUATION_FIRST`
- 진행 중 Problem이 없으면 `DISCOVERY`
- 기존 WordPress 글이 연결된 이후에는 관련 글/카테고리 문맥도 필요한 경우에만 추가
- 반려 기록이 있으면 해당 문제군을 다시 추천하지 않도록 문맥 추가
- 섹션이 필요하지 않으면 프롬프트에서 아예 제외

초기 일일 프롬프트는 외부 Collector 대신 ChatGPT Plus가 최신 웹을 조사하도록 지시한다.
후보를 억지로 만들지 않으며 가치 있는 신규 문제가 없으면 0개라고 답할 수 있어야 한다.

## 직접 경험 관련 하드 규칙

역할/상황/미션은 AI가 설계할 수 있지만 실제 행동과 결과를 지어내면 안 된다.

- OBSERVED: 사용자가 직접 확인한 것
- OFFICIAL: 공식 문서로 확인한 것
- INFERRED: 관찰/자료로부터 추론한 것. 불확실성을 표시
- UNVERIFIED: 발행 가능한 경험 서술로 사용 금지

Evidence가 없는 상태에서도 **배우 관찰형 블로그 초안**은 만든다. 다만 이것을 사용자가 실제로 해본 1인칭 경험담으로 위장하지 않는다. 한 명의 배우가 실제 생활 속에서 움직이고 관찰자가 옆에서 지켜보는 장면으로 글을 구성하며, 아직 확인되지 않은 성공/실패/해결 결과는 지어내지 않는다. 결과가 미확정인 장면은 글 흐름 안에서 관찰 질문으로 남긴다. 실제 Evidence가 들어오면 초안을 실제 사건 순서에 맞게 다시 구성하고 최종 Story Shape와 발행 가치를 판단한다.

## Natural Blog 원칙

최종 글은 SEO 템플릿보다 실제 사건 흐름을 따른다.

금지 기본값:
- 목표 글자 수를 채우기 위한 내용 늘리기
- H2/H3 개수 강제
- FAQ 자동 생성
- 표/체크리스트 자동 생성
- 내부 링크 개수 강제
- 의미 없는 이미지 개수 강제
- 매번 같은 도입/결론 문구
- 실제 하지 않은 행동을 "직접 해봤다"고 서술

허용:
- 짧은 글
- 이미지 없는 글
- H2가 하나뿐인 글
- 실패한 실험
- 해결되지 않은 기록
- 필요할 때만 표/목록/내부 링크 사용

Story Shape는 실제 Evidence에 따라 선택한다.
`QUICK_FIX`, `TRIAL_AND_ERROR`, `COMPARISON`, `DIAGNOSIS`, `WORKAROUND`, `NO_SOLUTION`을 허용한다.

## 반려 기억

Notion에서 `반려`한 문제는 Firestore `rejections`에 저장한다.
향후 프롬프트는 활성 반려 기록을 읽고 같은 문제를 반복 추천하지 않는다.

반려 범위:
- EXACT: 정확히 같은 문제
- CLUSTER: 같은 문제 의도/문제군
- SCOPE: 해당 영역 자체

`보류`는 영구 반려가 아니며 이후 재검토 가능하다.

## 주제 범위 확장

초기 주제 범위가 포화되면 `내 글들을 기반으로 다른 주제 추천받기` 기능을 추가한다.
현재 영역에서 인접한 영역만 제안하고 사용자가 승인하기 전에는 자동으로 ACTIVE Scope로 만들지 않는다.

예상 흐름:
현재 Scope → 인접 Scope 후보 → ChatGPT Plus 조사 → 사용자 승인 → ACTIVE → 이후 일일 조사 대상

## WordPress 연결 이후

WordPress를 연결하면 REST API로 글/카테고리를 Firestore에 동기화한다.
프롬프트는 전체 본문을 매번 넣지 않고 관련 카테고리/관련 글만 선별한다.

Notion의 `작성 완료`는 최종 발행이 아니다.
실제 WordPress Sync에서 게시글을 확인했을 때만 `발행 완료`로 승격한다.

## 자동화의 경계

초기에는 다음을 자동화하지 않는다.
- OpenAI API를 이용한 자동 글쓰기
- WordPress 자동 발행
- Evidence가 없는 경험담 생성

사용자가 충분히 검증한 뒤 필요한 부분만 단계적으로 자동화한다.

## 일일 탐색 V5 — 넓게 찾고, 실제로 해볼 것만 남기기

`activeScopes`는 고정 허용 목록이 아니라 이미 관심을 가져온 참고 앵커다.
일일 조사에서 앵커 밖 주제를 금지하지 않는다. 안전한 소비자 기술·디지털 생활·생산성 영역의 실제 문제 신호를 넓게 탐색한다.

일일 탐색은 다음 순서를 따른다.

1. 날짜별 탐색 렌즈를 바꿔 같은 유형으로 수렴하는 편향을 줄인다.
2. 내부적으로 최소 10개 이상의 서로 다른 Problem Territory를 넓게 탐색한다.
3. Firestore의 기존 Problem, 진행 중 Problem, 반려 기억, 향후 발행 글을 보고 실질 중복을 제거한다.
4. 상위 후보만 깊게 검증하고 최종 Problem은 최대 1개만 선택한다.
5. 글 콘셉트나 Story Shape를 미리 정하지 않고, 오늘 어떤 행동으로 새로운 Evidence를 만들지에 대한 검증 관점 하나만 고른다.
6. 한 명의 배우가 실제 사용자처럼 움직이는 `관찰 시나리오`를 만든다. 번호형 지시문보다 배우의 행동이 이어지는 3인칭 현재형 장면을 우선한다.
7. 관찰 시나리오를 별도 매뉴얼로 끝내지 않고 같은 응답에서 **관찰형 블로그 초안**으로 발전시킨다. 제목과 본문을 만들되 아직 확인되지 않은 결과는 사실처럼 만들지 않는다.
8. Story Seed와 필요한 Evidence는 별도 긴 섹션으로 반복하기보다 초안과 `PROBLEM_MEMORY_JSON`에 압축한다.
9. 실제 Evidence가 들어오면 OBSERVED / OFFICIAL / INFERRED / UNVERIFIED를 분리하고 초안을 실제 사건 순서에 맞게 다시 구성한다.
10. 실제 결과에 새 가치가 있으면 WRITE로 판단해 Story Shape를 선택하고 최종 Natural Blog로 확정한다. 가치가 없으면 RECORD_ONLY로 남기고 초안을 발행하지 않는다.

주제 다양성을 위해 단일 OS·앱·회사 생태계가 후보를 과도하게 점유하지 않게 한다. 날짜는 특정 주제를 임의 선택하는 장치가 아니라 최신성 경계와 탐색 관점을 바꾸는 시드로 사용한다.

## Daily Prompt 결과 피드백 루프

Daily Prompt에서 ChatGPT Plus가 고른 최종 Problem은 프롬프트 텍스트로만 끝내지 않는다.
선택 결과를 Firestore `problems`에 되먹여 다음 조사에서 중복/연속성 판단에 사용한다.

운영 흐름:

1. Daily Prompt는 답변 마지막에 `PROBLEM_MEMORY_JSON`을 출력하도록 요구한다.
2. 사용자는 Notion Daily Research 행의 `선택 결과 JSON` 속성에 그 JSON만 붙여넣는다.
3. `결과 반영` 체크박스를 켠다.
4. 다음 GitHub Action이 Notion을 읽고 결과를 Firestore에 반영한다.
5. `NEW`는 새 `problems` 문서로 생성하고 상태를 `IN_PROGRESS`로 둔다.
6. `CONTINUE`는 `existingProblemId`로 기존 Problem에 연결한다.
7. `HOLD`와 `NO_GO`는 Daily Prompt의 판단 이력만 기록하고 새 Problem을 만들지 않는다.
8. 반영이 끝나면 Daily Research 행의 `Problem ID`를 채우고 `결과 반영` 체크를 자동으로 해제한다.
9. 다음 Daily Prompt는 Problem ID, 제목, 상태, 검증 관점, 최근 직접 해볼 일, Story Seed을 기억 블록으로 읽는다.

같은 Problem을 제목만 바꾸어 NEW로 반복하지 않는다. 진행 중인 같은 문제라면 CONTINUE를 사용한다.
Notion은 결과 입력 UI이고 Firestore `problems`가 중복 방지의 원본 기억이다.


## Daily Research → 관찰형 초안 → 최종 Natural Blog

Daily Research의 목적은 **직접 확인할 가치가 있는 문제를 찾고, 그 문제를 문제 해결소다운 글의 형태로 먼저 보여주는 것**이다.

최종 Problem이 NEW 또는 CONTINUE이면 같은 응답에서 관찰형 블로그 초안까지 만든다.

- 오늘의 판단과 최종 Problem 0~1개
- 넓게 살펴본 범위와 유력 후보 소수
- 검증 관점 1개
- 배우가 실제 사용자처럼 움직이는 장면
- 그 장면을 중심으로 한 자연스러운 제목과 본문
- 실제 관찰 후 갱신해야 할 핵심 포인트 소수
- `PROBLEM_MEMORY_JSON`

배우 관찰형 초안은 사용자의 실제 경험을 위조하는 장치가 아니다. 배우의 행동과 공식/커뮤니티 근거를 이용해 문제 상황을 한 편의 글로 구성하되, 아직 확인되지 않은 결과는 관찰 질문이나 미확정 장면으로 남긴다.

사용자가 실제 결과를 제공하면 다음 순서를 따른다.

1. OBSERVED / OFFICIAL / INFERRED / UNVERIFIED 분리
2. 실제 사건 순서에 맞게 초안 구조 재조정
3. `WRITE / RECORD_ONLY` 판단
4. RECORD_ONLY면 초안을 발행하지 않고 기억만 남김
5. WRITE면 실제 결과에 맞는 Story Shape 선택 후 최종 Natural Blog 확정

최종 글은 Daily Research의 후보 순위나 운영 항목을 목차로 복사하지 않는다. `문제 → 원인 → 해결 → 결론` 같은 고정 틀도 기본값으로 사용하지 않으며, 실제 장면과 예상 밖 변화가 글 구조를 결정한다.

## Notion 최소 운영 스키마

현재 단계에서는 Notion을 복잡한 CMS처럼 사용하지 않는다.
필수 속성만 유지한다.

- 이름
- 상태
- 유형
- 생성 일시 (Notion Created time)
- Firestore ID
- 선택 결과 JSON
- 결과 반영
- 반려 이유
- 반려 범위

수동 `생성일` Date를 포함해 카테고리/세부영역/점수/연재정보/WordPress URL/Prompt Version 등은 Firestore에만 저장하고 Notion에서는 제거한다. 생성 시각 표시는 Notion 기본 `생성 일시`(Created time)를 사용한다.
필요해지는 시점에 다시 확장한다.

## 로컬 우선 테스트

코드 변경 직후 Vercel 배포를 기다리지 않고 `/Users/ungveloper/Desktop/UNG/problem-solving-research-web`에서 `npm run test:local`을 실행한다.
이 명령은 `.env.local`을 사용한다. 같은 저장소의 개발 서버가 이미 실행 중이면 그 서버를 재사용하고, 없을 때만 임시 포트에 Next 서버를 실행한다. 실제 Firestore/Notion에 대해 V5 Preview 전체 일일 흐름을 호출하며 자신이 시작한 서버만 종료한다.
Vercel/GitHub Actions는 로컬 검증이 끝난 뒤 최종 자동화 확인에 사용한다.
