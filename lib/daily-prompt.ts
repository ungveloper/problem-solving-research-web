import type {
  DailyPromptMode,
  DailyPromptRecord,
  ProblemRecord,
  SiteProfileRecord,
} from "@/lib/domain";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";
import { ensureSiteProfile } from "@/lib/site-profile";

const ACTIVE_STATUSES = ["IN_PROGRESS", "TESTING", "READY_TO_WRITE", "ARTICLE_READY"];
const PROMPT_VERSION = "daily-session-v5";

const EXPLORATION_LENSES = [
  "업데이트·버전 변경 뒤 생긴 회귀나 기본 동작 변화",
  "권한·보안·기본값 때문에 생기는 일상적인 마찰",
  "서로 다른 앱·기기·서비스 사이의 호환성·연동 문제",
  "파일·사진·문서·데이터를 옮기거나 변환할 때 생기는 문제",
  "동기화·백업·복원 과정에서 생기는 불일치와 누락",
  "저장공간·성능·배터리·네트워크처럼 시간이 지나며 누적되는 문제",
  "브라우저·웹앱에서 특정 조건에만 나타나는 동작 차이",
  "반복 작업을 번거롭게 만드는 작은 워크플로 마찰",
  "설치·업그레이드·마이그레이션 전후의 예상 밖 변화",
  "오프라인·네트워크 전환·다중 기기 환경에서 생기는 문제",
  "표시·미리보기·입출력·프린트·스캔처럼 눈에 보이는 결과 문제",
  "검색·정리·이름 변경·복구처럼 정보 관리 과정에서 생기는 문제",
] as const;

type RejectionRecord = {
  title?: string;
  category?: string;
  reason?: string;
  scope?: string;
  active?: boolean;
  rejectedAt?: string;
};

type ArticleRecord = {
  title?: string;
  url?: string;
  categoryNames?: string[];
  excerptText?: string;
  modifiedAt?: string;
};

type PromptOptions = {
  previewV5?: boolean;
};

function koreaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function stableSeed(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dailyExplorationLenses(dateKey: string) {
  const start = stableSeed(dateKey) % EXPLORATION_LENSES.length;
  const picks: string[] = [];
  const step = 5;
  for (let index = 0; picks.length < 4 && index < EXPLORATION_LENSES.length; index += 1) {
    const lens = EXPLORATION_LENSES[(start + index * step) % EXPLORATION_LENSES.length];
    if (!picks.includes(lens)) picks.push(lens);
  }
  return picks;
}

function buildAnchorBlock(profile: SiteProfileRecord) {
  return [
    "[참고 앵커 — 제한 목록이 아님]",
    ...profile.activeScopes.map((scope) => `- ${scope}`),
    "위 목록은 이 프로젝트가 이미 관심을 가진 출발점일 뿐 화이트리스트가 아니다.",
    "오늘 웹에서 더 강한 문제 신호가 보이면 목록 밖의 소비자 기술·디지털 생활·생산성 영역도 적극적으로 탐색한다.",
    "단, 의료·법률·투자·안전처럼 고위험 판단이 필요한 분야와 직접 검증하기 어려운 주제는 제외한다.",
  ].join("\n");
}

function buildDailyLensBlock(dateKey: string) {
  const lenses = dailyExplorationLenses(dateKey);
  return [
    "[오늘의 탐색 렌즈 — 주제가 아니라 검색 관점]",
    ...lenses.map((lens, index) => `${index + 1}. ${lens}`),
    "이 렌즈들은 매일 탐색 편향을 바꾸기 위한 관점이다. 렌즈에 억지로 주제를 맞추지 말고 실제 웹 신호가 약하면 버린다.",
    "날짜는 주제를 임의로 정하는 용도가 아니라 최신성 경계와 탐색 렌즈를 바꾸는 시드로만 사용한다.",
  ].join("\n");
}

function buildPrincipleBlock(profile: SiteProfileRecord) {
  return ["[이 블로그의 고정 원칙]", ...profile.principles.map((rule) => `- ${rule}`)].join("\n");
}

function buildActiveProblemsBlock(problems: Array<{ id: string; data: ProblemRecord }>) {
  if (problems.length === 0) return "";
  return [
    "[진행 중인 문제 — 신규 주제보다 먼저 검토]",
    ...problems.slice(0, 12).map((item, index) =>
      [
        `${index + 1}. ${item.data.title}`,
        `   상태: ${item.data.status}`,
        `   카테고리: ${item.data.category ?? "미지정"}`,
        `   현재 일차: ${item.data.currentDay ?? 1}`,
        `   Story Shape: ${item.data.storyMode ?? "Evidence 전 미정"}`,
        item.data.whyRecommended ? `   배경: ${item.data.whyRecommended}` : "",
      ].filter(Boolean).join("\n"),
    ),
    "진행 중인 문제에 실제로 다음 검증 행동이 있으면 CONTINUE를 우선한다. 단지 연재를 유지하기 위해 문제를 늘이지 않는다.",
  ].join("\n");
}

function buildProblemMemoryBlock(problems: Array<{ id: string; data: ProblemRecord }>) {
  const recent = [...problems]
    .sort((a, b) => String(b.data.updatedAt ?? "").localeCompare(String(a.data.updatedAt ?? "")))
    .slice(0, 80);
  if (recent.length === 0) return "";

  return [
    "[Problem 기억 인덱스 — 신규 중복 방지와 연속성 판단용]",
    ...recent.map((item, index) =>
      [
        `${index + 1}. ID: ${item.id} / ${item.data.title}`,
        `   상태: ${item.data.status} / 카테고리: ${item.data.category ?? "미지정"} / 세부: ${item.data.detailArea ?? "미지정"}`,
        item.data.contentConcept ? `   검증 관점: ${item.data.contentConcept}` : "",
        item.data.missionSummary ? `   최근 행동 흐름: ${item.data.missionSummary}` : "",
        item.data.storySeed ? `   Story Seed: ${item.data.storySeed}` : "",
        item.data.sourceDailyPromptDateKey ? `   최초/최근 선택일: ${item.data.sourceDailyPromptDateKey}` : "",
      ].filter(Boolean).join("\n"),
    ),
    "같은 제품명을 쓰는 것만으로 중복은 아니지만, 같은 사용자 문제·같은 원인 가설·같은 해결 또는 같은 Evidence를 다시 만드는 후보는 NEW로 취급하지 않는다.",
    "진행 중 Problem과 실질적으로 같은 문제라면 NEW가 아니라 CONTINUE로 판단하고 반드시 해당 ID를 사용한다.",
  ].join("\n");
}

function buildRejectionBlock(rejections: Array<{ id: string; data: RejectionRecord }>) {
  if (rejections.length === 0) return "";
  return [
    "[과거 반려 기억 — 다시 추천하지 않기]",
    ...rejections.slice(0, 30).map((item, index) =>
      `${index + 1}. ${item.data.title ?? "제목 없음"} / 범위: ${item.data.scope ?? "CLUSTER"} / 이유: ${item.data.reason ?? "기타"}`,
    ),
    "EXACT는 같은 문제를, CLUSTER는 같은 문제 의도·원인·해결군을, SCOPE는 해당 영역 자체를 다시 추천하지 않는다.",
  ].join("\n");
}

function buildArticleBlock(articles: Array<{ id: string; data: ArticleRecord }>) {
  if (articles.length === 0) {
    return [
      "[기존 발행 글]",
      "아직 WordPress를 연결하지 않은 검증 단계라 기존 발행 글 DB가 비어 있다.",
      "없는 기존 글을 추정하거나 만들어내지 않는다.",
    ].join("\n");
  }

  return [
    "[기존 발행 글 — 중복/연속성 판단용]",
    ...articles.slice(0, 25).map((item, index) =>
      [
        `${index + 1}. ${item.data.title ?? "제목 없음"}`,
        `   카테고리: ${(item.data.categoryNames ?? []).join(", ") || "미지정"}`,
        item.data.url ? `   URL: ${item.data.url}` : "",
        item.data.excerptText ? `   요약: ${item.data.excerptText.slice(0, 240)}` : "",
      ].filter(Boolean).join("\n"),
    ),
  ].join("\n");
}

function discoveryInstructions() {
  return [
    "[오늘의 모드: BROAD_DISCOVERY]",
    "처음부터 특정 제품이나 파일 형식을 고르지 않는다. 먼저 웹을 넓게 탐색해 '어떤 문제 영역이 오늘 가치가 있는지'부터 찾는다.",
    "1차 탐색에서는 최소 10개, 가능하면 12~15개의 서로 다른 Problem Territory를 짧게 만든다.",
    "한 회사·한 OS·한 앱 생태계가 전체 후보의 25%를 넘지 않게 한다. 같은 종류의 PDF/Windows 문제만 여러 개 나열하는 식의 후보 부풀리기를 금지한다.",
    "후보 구성은 대략 앵커 연관 35%, 인접 영역 35%, 목록 밖 오픈 탐색 30%를 목표로 하되 실제 웹 신호가 우선이다.",
    "오픈 탐색은 일반 사용자가 직접 재현 가능한 소비자 기술·디지털 생활·생산성 문제에서 찾는다.",
    "1차 후보를 만든 뒤에만 반복 신호, 직접 검증 가능성, 독자 결과 가치가 높은 5개 이하를 2차 후보로 좁힌다.",
  ].join("\n");
}

function continuationInstructions() {
  return [
    "[오늘의 모드: CONTINUATION_FIRST + BROAD_DISCOVERY]",
    "진행 중인 문제를 먼저 검토한다.",
    "이전 결과를 반복하지 말고 오늘 원인을 더 좁히거나 결과를 확인할 구체적인 다음 행동이 있는지 판단한다.",
    "다음 행동의 정보가치가 충분하면 CONTINUE한다.",
    "진행 중 문제를 이어갈 실질적 이유가 없으면 과감히 HOLD하고, 그 다음에는 BROAD_DISCOVERY 절차로 신규 문제를 찾는다.",
  ].join("\n");
}


function resultMemoryContract() {
  return [
    "[운영 DB로 되먹일 PROBLEM_MEMORY_JSON]",
    "Daily Research 답변의 맨 마지막에 반드시 JSON 코드 블록을 하나만 추가한다.",
    "이 JSON은 Notion의 '선택 결과 JSON' 속성에 붙여넣어 Firestore Problem 기억으로 반영하는 운영 메타데이터다.",
    "JSON 전체를 1,400자 이내로 유지하고 설명문·인용·URL·마크다운을 JSON 값 안에 넣지 않는다.",
    "NEW이면 title/category/detailArea/concept/whyRecommended/missionSummary/storySeed를 채운다. missionSummary는 사용자 지시 체크리스트가 아니라 화자가 어떤 행동을 거쳐 확인할지 한 문장으로 요약한다.",
    "storySeed는 배열이 아니라 짧은 문자열 하나로 쓴다. 여러 장면이면 ' / '로 압축해 한 문자열 안에 넣는다.",
    "concept는 블로그 형식이나 Story Shape가 아니라 '무엇을 확인할지'에 대한 검증 관점이다.",
    "Evidence 전에는 storyMode를 새로 정하지 않는다. 기존 CONTINUE Problem에 이미 storyMode가 있더라도 오늘 실제 결과가 바뀌면 Evidence 이후 다시 판단할 수 있다.",
    "CONTINUE이면 existingProblemId를 Problem 기억 인덱스의 정확한 ID로 채운다.",
    "HOLD/NO_GO이면 decision과 짧은 whyRecommended만 남기고 없는 필드는 생략한다.",
    "예시 키: decision, title, category, detailArea, concept, whyRecommended, missionSummary, storySeed, existingProblemId",
  ].join("\n");
}

function verificationInstructions() {
  return [
    "[Problem 선택 뒤 검증 관점]",
    "최종 Problem을 골랐다고 글의 콘셉트나 Story Shape를 미리 정하지 않는다.",
    "오늘은 '무엇을 직접 확인하면 새로운 Evidence가 생기는가'만 판단해 검증 관점 하나를 고른다.",
    "A/B 비교, 재현, 원인 좁히기, 공식 해결 재확인, 우회 방법 확인 등은 검증 수단일 뿐 최종 글 템플릿이 아니다.",
    "실제 결과가 예상과 다르면 검증 관점과 이후 Story Shape도 바뀔 수 있어야 한다.",
  ].join("\n");
}

function actorObserverInstructions() {
  return [
    "[내부 행동 시나리오 — 블로그 본문에는 노출하지 않음]",
    "오늘 할 행동을 '1. 확인하세요 / 2. 눌러보세요' 같은 사용자용 체크리스트로 쓰지 않는다.",
    "내부적으로는 한 명의 평범한 사용자가 실제 생활 속에서 문제를 겪고 움직이는 장면을 시간 순서대로 설계한다.",
    "이 내부 시나리오는 블로그의 행동 흐름을 만들기 위한 설계 도구일 뿐이다. 최종 블로그 본문에는 '배우', '관찰자', '한 사용자', '사용자는' 같은 표현을 쓰지 않는다.",
    "블로그 초안으로 옮길 때는 내부 시나리오의 행동을 화자 '나'의 1인칭 체험 서술로 변환한다. 예: '테스트용 캘린더를 하나 만들어봤다', '같은 파일을 두 곳에 넣어봤다', '두 화면을 나란히 비교해봤다'.",
    "앱을 열고, 메뉴를 누르고, 파일을 만들고, 다시 실행하고, 나란히 비교하는 행동 자체는 1인칭으로 자연스럽게 서술한다.",
    "아직 확인되지 않은 성공·실패·오류·해결 결과는 만들어내지 않는다. 행동은 내가 해본 것처럼 쓰되, 결과가 갈리는 지점에서는 실제 Evidence 없이 어느 쪽이 나왔다고 단정하지 않는다.",
    "공식 문서의 예상 동작은 배경 정보로만 사용한다. 공식 예상과 실제 결과를 같은 경험처럼 섞지 않는다.",
    "불필요하게 모든 설정을 측정하거나 반복 횟수를 강제하지 않는다. 이 문제를 이해하는 데 필요한 행동 흐름만 남긴다.",
  ].join("\n");
}

function observationBlogDraftInstructions() {
  return [
    "[1인칭 체험형 블로그 초안 — NEW/CONTINUE이면 반드시 작성]",
    "최종 Problem이 NEW 또는 CONTINUE로 선택되면 같은 응답에서 자연스러운 블로그 제목과 본문을 반드시 작성한다.",
    "블로그 본문은 처음부터 끝까지 화자 '나'의 시점으로 쓴다. 내부 설계에 사용한 배우·관찰자 개념은 본문에 노출하지 않는다.",
    "행동은 내가 직접 해본 것처럼 자연스럽게 서술한다. '만들어봤다', '열어봤다', '넣어봤다', '눌러봤다', '다시 실행해봤다', '나란히 비교해봤다' 같은 1인칭 체험 문장을 적극적으로 사용한다.",
    "본문에서 '배우', '관찰자', '한 사용자', '사용자는', '배우는' 같은 표현을 쓰지 않는다. 주어가 필요하면 '나는' 또는 자연스러운 주어 생략을 사용한다.",
    "아직 실제 Evidence로 확인되지 않은 성공·실패·오류·해결 결과는 만들어내지 않는다. 예를 들어 0개가 떴다고 확인되지 않았다면 '0개가 떴다'고 쓰지 않는다. 대신 가져와보고, 화면을 열어보고, 두 결과를 비교해봤다는 행동까지 1인칭으로 서술하고 실제 결과가 필요한 지점은 중립적으로 남긴다.",
    "결과가 미확정이라고 해서 '[실험 후 교체]' 같은 자리표시자로 도배하지 않는다. '여기서 확인하려던 건 결과 메시지와 실제 일정이 같은지였다', '두 파일을 나란히 놓고 차이가 있는지 봤다'처럼 자연스러운 체험 흐름을 유지한다.",
    "웹 조사, 공식 문서, 커뮤니티 제보는 내가 왜 이 행동을 해봤는지 설명할 때만 필요한 만큼 녹인다. 리서치 보고서를 본문으로 복사하지 않는다.",
    "도입은 가능하면 내가 실제 문제를 마주친 장면에서 시작한다. '최근 많은 사용자가', '이번 글에서는', '한 사용자가' 같은 일반적인 AI 도입을 기본값으로 쓰지 않는다.",
    "제목, H2, 본문, 마무리는 내용에 따라 자유롭게 구성한다. 모든 글을 문제→원인→해결→결론 구조로 만들지 않는다.",
    "초안 상단이나 본문 안에 '배우 관찰형 초안', '실험 전 초안', '가상의 사용자' 같은 설명을 붙이지 않는다. 독자가 읽는 부분은 처음부터 문제 해결소의 자연스러운 개인 블로그 글처럼 보여야 한다.",
    "실제 Evidence가 들어오면 초안의 1인칭 행동 흐름은 유지하되, 확인된 결과만 OBSERVED에 맞게 고쳐 최종 경험 글로 확정한다.",
  ].join("\n");
}

function firstPersonIdentityGuardInstructions() {
  return [
    "[문제 해결소 아이덴티티 회귀 방지 — 다른 편집 규칙보다 우선]",
    "블로그 초안의 핵심 정체성은 '내가 직접 움직여 문제를 확인해본 개인 블로그'다. 이후의 압축, 이미지 계획, 구조 편집이 이 1인칭 체험감을 약하게 만들면 안 된다.",
    "본문의 주요 전개는 일반 설명보다 내가 실제로 한 행동·판단·비교를 중심으로 이어간다. 설명이 필요해도 '그래서 직접 ~해봤다', '여기서 ~를 비교해봤다', '내가 먼저 본 건 ~였다'처럼 행동 흐름에 붙인다.",
    "편집하면서 1인칭 행동 문장을 '사용자는 ~해야 한다', '~할 필요가 있다', '~하는 것이 좋다' 같은 일반 가이드 문장으로 바꾸지 않는다.",
    "아직 결과가 없다는 이유로 행동까지 미래형 계획으로 되돌리지 않는다. '해볼 생각이다', '시도할 예정이다', '흐름으로 정리했다'보다 실제 행동형인 '만들어봤다', '가져와봤다', '나란히 비교해봤다'를 우선한다.",
    "단, 성공·실패·오류 발생·해결 여부처럼 Evidence가 필요한 결과만 확정하지 않는다. 행동은 1인칭 완료형, 미확인 결과는 중립적으로 분리한다.",
    "H2와 마지막 문단도 이 정체성을 유지한다. 일반 정보 글의 교과서식 소제목보다 내가 무엇을 해보고 어떤 기준을 잡았는지가 자연스럽게 드러나야 한다.",
    "본문 안에 '편집 상태', '검증용 초안', '발행 보류', '가상의 사용자', '배우', '관찰자' 같은 제작 메타 문구를 넣지 않는다. 운영 상태는 블로그 본문 밖에서만 다룬다.",
  ].join("\n");
}

function editorialQualityInstructions() {
  return [
    "[초안 작성 후 편집자 자체 점검 — 출력 전에 반드시 수행]",
    "목표 글자 수나 최소 분량을 두지 않는다. 핵심이 전달됐으면 짧게 끝내고, 길이를 채우기 위해 배경·질문·가설·계획을 반복하지 않는다.",
    "각 문단은 새 장면, 새 근거, 새 구분 기준, 새 행동 이유 중 최소 하나를 추가해야 한다. 앞 문단과 같은 뜻이면 합치거나 삭제한다.",
    "H2는 내용의 역할이 실제로 바뀔 때만 만든다. 같은 검증 계획을 다른 표현으로 반복하는 H2는 합친다.",
    "도입에서 제기한 핵심 질문은 본문에서 한 번만 충분히 설명한다. 같은 질문을 중간과 마지막에 다시 던져 글자 수를 늘리지 않는다.",
    "초안이 끝난 뒤 전체를 다시 읽고 의미가 겹치는 문장·문단을 제거한다. 삭제해도 정보가 줄지 않는 문장은 남기지 않는다.",
    "행동을 이미 했다는 흐름으로 쓰다가 '시도하는 흐름으로 정리했다', '해볼 생각이다', '살펴볼 예정이다' 같은 계획서 말투로 후퇴하지 않는다. 결과만 미확정으로 두고 행동은 일관되게 1인칭 체험형으로 유지한다.",
    "Evidence 전 소제목이 아직 확인하지 않은 인과나 결론을 단정하지 않게 한다. 예: '다시 가져오면 안 되는 이유'보다 '바로 다시 가져오기 전에 확인한 것'처럼 행동·판단 기준 중심으로 쓴다.",
    "마지막 단락은 질문을 다시 늘어놓거나 '확인해보려 한다', '확인하면 좋겠다', '것 같다'만 반복하며 끝내지 않는다.",
    "실제 결과가 아직 없어도 현재 조사 단계에서 독자가 지금 먼저 확인할 한 가지 기준을 짧고 구체적으로 남기며 글을 닫는다. 가능하면 '무엇보다 먼저 A를 보고, 그 다음 B를 좁힌다'처럼 행동 순서가 보이게 한다.",
    "잠정 판단과 실제 검증 결과를 혼동하지 않는다. 아직 확인하지 않은 결과는 결론처럼 단정하지 않는다.",
    "최종 자체 점검 질문: 이 문단이 없으면 핵심 이해가 떨어지는가? 아니면 분량만 줄어드는가? 후자면 삭제한다.",
  ].join("\n");
}

function imagePlanInstructions() {
  return [
    "[이미지 계획 — 필요한 경우에만]",
    "이미지 수를 채우지 않는다. 글을 이해하거나 실제 차이를 증명하는 데 도움이 될 때만 0~3개를 제안한다.",
    "각 이미지에는 반드시 '삽입 위치 / 목적 / 종류'를 적는다.",
    "이미지를 제안했다면 블로그 본문 안의 정확한 삽입 지점에도 대응 마커를 직접 넣는다. 형식은 '[이미지 1 삽입: 짧은 설명 — 실제 캡처]' 또는 '[이미지 1 삽입: 짧은 설명 — 생성 이미지]'처럼 쓴다.",
    "본문 마커의 이미지 번호와 설명은 아래 이미지 계획의 번호·제목과 정확히 일치해야 한다. 이미지 계획에 없는 마커를 본문에 만들지 않고, 이미지가 0개라면 본문 마커도 만들지 않는다.",
    "본문 마커는 독자가 읽는 문장 사이에서 이미지가 가장 이해를 돕는 바로 그 위치에 한 줄로 배치한다. 문단 끝에 몰아넣지 않는다. 실제 이미지가 확보되면 이 마커를 이미지로 교체하고 마커 문구는 제거한다.",
    "실제 제품 화면, 오류 메시지, 전후 비교처럼 Evidence 역할을 하는 이미지는 AI로 만들지 않는다. '종류: 실제 캡처(생성 금지)'라고 표시하고 실제로 캡처할 화면만 설명한다.",
    "개념 설명, 대표 이미지, 단계 흐름처럼 사실 증거가 아닌 보조 시각물만 생성 이미지로 제안할 수 있다.",
    "생성 이미지가 유용하면 바로 사용할 수 있는 상세 이미지 생성 프롬프트를 함께 쓴다. 프롬프트에는 가짜 제품 UI, 가짜 오류 문구, 존재하지 않는 결과를 만들지 말라고 명시한다.",
    "생성 이미지가 글에 실질적 도움을 주지 않으면 '생성 이미지 없음'이라고 판단한다. 억지 썸네일이나 장식 이미지를 만들지 않는다.",
    "실제 Evidence가 들어온 뒤에는 생성 이미지보다 실제 스크린샷을 우선한다.",
  ].join("\n");
}

function storySeedInstructions() {
  return [
    "[Story Seed — 운영 기억용]",
    "관찰형 블로그 초안에서 실제 결과가 들어왔을 때 이야기의 중심이 될 만한 장면을 3~5개 골라 내부적으로 정리한다.",
    "Story Seed는 사용자에게 별도 보고서처럼 길게 펼치지 말고 PROBLEM_MEMORY_JSON의 storySeed에 짧게 압축한다.",
    "예: 처음 이상함을 발견한 순간 / 한 조건만 바꿨는데 달라질 수 있는 장면 / 전후 차이를 보여주는 화면이나 시간 / 문제가 재현되지 않는 결과 자체.",
  ].join("\n");
}

function postEvidenceNaturalBlogInstructions() {
  return [
    "[실제 Evidence가 들어온 뒤 초안을 최종 글로 갱신]",
    "사용자가 실제 관찰 결과를 보내면 OBSERVED / OFFICIAL / INFERRED / UNVERIFIED로 먼저 분리한다.",
    "이미 만든 관찰형 초안을 기계적으로 빈칸 채우듯 수정하지 않는다. 실제로 벌어진 사건 순서와 예상 밖 결과에 맞춰 구조를 다시 잡는다.",
    "실제 결과가 독립된 글 가치가 없으면 RECORD_ONLY로 남기고 초안을 발행하지 않는다.",
    "글 가치가 있으면 WRITE로 판단하고 QUICK_FIX / TRIAL_AND_ERROR / COMPARISON / DIAGNOSIS / WORKAROUND / NO_SOLUTION 중 실제 사건에 맞는 Story Shape를 그때 선택한다.",
    "최종 글은 Daily Research의 후보 순위, Mission, Evidence 표를 복사하지 않는다. 1인칭 행동 흐름과 실제 OBSERVED 결과가 중심이 된다.",
    "실패, 재현 실패, 해결되지 않음도 독자에게 도움이 되면 그대로 최종 글이 될 수 있다.",
    "실제로 확인되지 않은 행동이나 해결은 최종 글에 추가하지 않는다.",
  ].join("\n");
}

export async function composeDailySessionPrompt(dateKey = koreaDateKey()) {
  const profileDoc = await ensureSiteProfile();
  const [problemDocs, rejectionDocs, articleDocs] = await Promise.all([
    listDocuments<ProblemRecord>("problems", 300),
    listDocuments<RejectionRecord>("rejections", 300),
    listDocuments<ArticleRecord>("articles", 300),
  ]);

  const activeProblems = problemDocs
    .filter((item) => ACTIVE_STATUSES.includes(item.data.status))
    .sort((a, b) => String(b.data.updatedAt ?? "").localeCompare(String(a.data.updatedAt ?? "")));
  const rejections = rejectionDocs
    .filter((item) => item.data.active !== false)
    .sort((a, b) => String(b.data.rejectedAt ?? "").localeCompare(String(a.data.rejectedAt ?? "")));
  const articles = articleDocs
    .sort((a, b) => String(b.data.modifiedAt ?? "").localeCompare(String(a.data.modifiedAt ?? "")));

  const mode: DailyPromptMode = activeProblems.length > 0 ? "CONTINUATION_FIRST" : "DISCOVERY";
  const blocks = [
    [
      "[역할]",
      "당신은 '문제 해결소'의 오늘 문제 리서처이자 실험 설계자다.",
      "목표는 미리 정해진 카테고리에서 소재 하나를 뽑는 것이 아니라, 현재 웹에서 실제 문제 신호를 넓게 발견하고 그중 직접 검증할 가치가 가장 큰 문제를 고르는 것이다.",
      "Daily Research는 최종 Problem을 고른 뒤 내부 행동 시나리오를 바탕으로 문제 해결소 스타일의 1인칭 체험형 블로그 초안까지 만드는 단계다. 행동은 내가 직접 해본 것처럼 쓰되 아직 확인되지 않은 성공·실패·해결 결과는 지어내지 않는다.",
      `기준 날짜: ${dateKey} (Asia/Seoul)`,
    ].join("\n"),
    buildPrincipleBlock(profileDoc.data),
    buildAnchorBlock(profileDoc.data),
    buildDailyLensBlock(dateKey),
    mode === "CONTINUATION_FIRST" ? continuationInstructions() : discoveryInstructions(),
    buildActiveProblemsBlock(activeProblems),
    buildProblemMemoryBlock(problemDocs),
    buildRejectionBlock(rejections),
    buildArticleBlock(articles),
    [
      "[웹 조사 순서]",
      "1. 먼저 여러 영역을 얕고 넓게 검색해 Problem Territory를 만든다. 처음부터 해결법 검색으로 좁히지 않는다.",
      "2. 커뮤니티·질문·이슈의 반복 신호와 공식 문서·릴리스 노트의 현재 동작을 분리해 확인한다.",
      "3. 서로 다른 출처에서 같은 불편이 반복되는지 확인하고, 단일 바이럴 글이나 뉴스 한 건만으로 후보를 올리지 않는다.",
      "4. 2차 후보만 더 깊게 검색한다. 이미 검색 결과 상단에 충분한 해결 글이 많아 새 Evidence 가치가 낮으면 감점한다.",
      "5. 내가 직접 재현할 수 없는 장비·계정·유료 서비스가 필수라면 HOLD 또는 제외한다.",
      "6. 의료·법률·투자·안전처럼 고위험 판단이 필요한 영역은 제외한다.",
    ].join("\n"),
    [
      "[후보 평가 기준]",
      "각 2차 후보를 반복성 / Evergreen / 직접 검증 가능성 / 독자 결과 가치 / 독창적 Evidence 가능성 / 검색 결과 포화도 / 필요한 장비·계정 부담으로 평가한다.",
      "정확한 숫자 점수보다 비교 이유가 중요하다. 약한 후보를 억지로 80점 이상으로 만들지 않는다.",
      "오늘 발행 가치가 있는 신규 Problem이 0개여도 정상이다.",
    ].join("\n"),
    verificationInstructions(),
    actorObserverInstructions(),
    observationBlogDraftInstructions(),
    firstPersonIdentityGuardInstructions(),
    editorialQualityInstructions(),
    imagePlanInstructions(),
    storySeedInstructions(),
    postEvidenceNaturalBlogInstructions(),
    [
      "[출력 원칙]",
      "내부적으로는 10~15개 Problem Territory를 넓게 만들고 상위 후보를 검증하되, 사용자에게 그 전체 목록을 보고서처럼 모두 펼치지 않는다.",
      "리서치 설명은 짧게 유지하고, 응답의 중심은 1인칭 체험형 블로그 초안이 되게 한다. 표와 점수표는 비교에 꼭 필요할 때만 사용한다.",
      "내부 행동 시나리오, 기록할 Evidence, Story Seed를 각각 긴 운영 섹션으로 반복하지 말고 블로그 초안 안에 자연스럽게 녹인다.",
      "블로그 본문에는 배우·관찰자·한 사용자라는 표현을 노출하지 않는다. 운영 정보보다 내가 직접 움직이는 문제 장면과 글의 흐름이 더 많은 비중을 차지해야 한다.",
      "초안을 출력하기 전에 중복 문단, 억지 분량, 애매한 마지막 문단을 편집자 관점에서 한 번 더 줄이되, 1인칭 체험형 행동 흐름은 절대 일반 가이드 말투로 약화시키지 않는다.",
      "이미지는 필요한 경우에만 제안하고, 실제 Evidence 스크린샷과 생성 가능한 설명 이미지를 명확히 구분한다. 제안한 이미지는 본문 안의 정확한 위치에도 같은 번호의 삽입 마커를 표시한다.",
    ].join("\n"),
    [
      "[출력 형식]",
      "1. 오늘의 판단: CONTINUE / NEW / HOLD / NO_GO와 최종 Problem 0~1개. 선택 이유는 핵심만 짧게 설명",
      "2. 오늘 살펴본 범위: 넓게 본 영역을 2~4줄로 요약하고, 최종 선택 외에 정말 의미 있었던 후보가 있으면 최대 2개만 짧게 표시",
      "3. 문제 해결소 블로그 초안: NEW/CONTINUE이면 반드시 자연스러운 제목과 본문을 작성. 내부 행동 시나리오를 화자 나의 1인칭 체험 서술로 변환하고, 배우·관찰자·한 사용자라는 표현은 본문에서 금지. 리서치/공식 자료는 필요한 만큼만 녹이고 별도의 시나리오·Evidence 표·Story Seed 섹션을 반복해서 만들지 않음. 출력 전 중복·늘어짐·애매한 마무리를 자체 편집하되 1인칭 체험감은 보존. 이미지가 필요하면 실제 들어갈 자리마다 '[이미지 N 삽입: 설명 — 종류]' 마커를 본문에 직접 표시",
      "4. 이미지 계획: 필요한 경우에만 최대 3개. 본문 마커와 동일한 번호·설명을 사용해 각 항목에 삽입 위치/목적/종류를 적고, 생성 이미지라면 상세 생성 프롬프트를 제공. 실제 화면·오류·전후 Evidence는 '실제 캡처(생성 금지)'로 표시. 불필요하면 생성 이미지 없음",
      "5. 실제 관찰 후 업데이트할 포인트: 최종본으로 바꿀 때 반드시 확인해야 할 장면이나 결과를 최대 3개만 짧게 표시",
      "6. PROBLEM_MEMORY_JSON: 답변 맨 마지막에 운영 DB 반영용 JSON 코드 블록 출력",
    ].join("\n"),
    resultMemoryContract(),
  ].filter(Boolean);

  return { prompt: blocks.join("\n\n"), mode };
}

export async function ensureDailyPrompt(dateKey = koreaDateKey(), options: PromptOptions = {}) {
  const previewSuffix = options.previewV5 ? `-v5-preview-${Date.now()}` : "";
  const id = `daily-${dateKey}${previewSuffix}`;
  if (!options.previewV5) {
    const existing = await getDocument<DailyPromptRecord>("dailyPrompts", id);
    if (existing) return { ...existing, created: false };
  }

  const { prompt, mode } = await composeDailySessionPrompt(dateKey);
  const now = new Date().toISOString();
  const record: DailyPromptRecord = {
    title: `${dateKey} 오늘의 문제 조사 프롬프트${options.previewV5 ? " · V5 Preview" : ""}`,
    dateKey,
    status: "RECOMMENDED",
    mode,
    prompt,
    promptVersion: `${PROMPT_VERSION}-${mode.toLowerCase()}${options.previewV5 ? "-preview" : ""}`,
    createdAt: now,
    updatedAt: now,
  };

  await upsertDocument("dailyPrompts", id, record);
  return { id, data: record, created: true };
}

export async function attachDailyPromptNotionPage(id: string, page: { id: string; url?: string }) {
  await patchDocument("dailyPrompts", id, {
    notionPageId: page.id,
    notionUrl: page.url ?? "",
    updatedAt: new Date().toISOString(),
  });
}
