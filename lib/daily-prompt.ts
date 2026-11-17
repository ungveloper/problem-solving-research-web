import type {
  DailyPromptMode,
  DailyPromptRecord,
  ProblemRecord,
  SiteProfileRecord,
} from "@/lib/domain";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";
import { ensureSiteProfile } from "@/lib/site-profile";

const ACTIVE_STATUSES = ["IN_PROGRESS", "TESTING", "READY_TO_WRITE", "ARTICLE_READY"];
const PROMPT_VERSION = "daily-session-v5.10";

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
    "행동은 내가 직접 해본 것처럼 자연스럽게 서술하되 특정 어미, 문장 패턴, 반복 표현을 템플릿처럼 고정하지 않는다. 주제와 실제 행동에 맞는 말투를 매번 새로 선택한다.",
    "본문에서 '배우', '관찰자', '한 사용자', '사용자는', '배우는' 같은 표현을 쓰지 않는다. 주어가 필요하면 '나는' 또는 자연스러운 주어 생략을 사용한다.",
    "아직 실제 Evidence로 확인되지 않은 성공·실패·오류·해결 결과는 만들어내지 않는다. 예를 들어 0개가 떴다고 확인되지 않았다면 '0개가 떴다'고 쓰지 않는다. 대신 가져와보고, 화면을 열어보고, 두 결과를 비교해봤다는 행동까지 1인칭으로 서술하고 실제 결과가 필요한 지점은 중립적으로 남긴다.",
    "결과가 미확정이라고 해서 '[실험 후 교체]' 같은 자리표시자로 도배하지 않는다. '여기서 확인하려던 건 결과 메시지와 실제 일정이 같은지였다', '두 파일을 나란히 놓고 차이가 있는지 봤다'처럼 자연스러운 체험 흐름을 유지한다.",
    "웹 조사, 공식 문서, 커뮤니티 제보는 내가 왜 이 행동을 해봤는지 설명할 때만 필요한 만큼 녹인다. 리서치 보고서를 본문으로 복사하지 않는다.",
    "도입 방식은 고정하지 않는다. 사건 한복판, 짧은 배경, 결과에서 역으로 시작, 의문, 실패 장면, 짧은 한 문장 등 이번 경험에 가장 자연스러운 방식으로 시작한다. 이전 글의 도입 패턴을 습관적으로 반복하지 않는다.",
    "제목과 본문 내부 구성은 완전히 자유다. H2/H3가 없어도 되고 하나 또는 여러 개여도 된다. 문단 수, 목록·표 사용, 도입·전개·마무리 방식, 결론 섹션 유무를 미리 정하지 않는다. 실제 경험과 전달할 내용이 필요한 형태를 결정한다.",
    "초안 상단이나 본문 안에 '배우 관찰형 초안', '실험 전 초안', '가상의 사용자' 같은 설명을 붙이지 않는다. 독자가 읽는 부분은 처음부터 문제 해결소의 자연스러운 개인 블로그 글처럼 보여야 한다.",
    "실제 Evidence가 들어오면 초안의 1인칭 행동 흐름은 유지하되, 확인된 결과만 OBSERVED에 맞게 고쳐 최종 경험 글로 확정한다.",
  ].join("\n");
}

function firstPersonIdentityGuardInstructions() {
  return [
    "[문제 해결소 아이덴티티 회귀 방지 — 구조 규칙보다 우선]",
    "블로그의 핵심 정체성은 '진짜 경험을 해본 사람이 자기 말로 남기는 1인칭 후기·문제 해결 기록'이다. 어떤 후속 편집도 이 체험감을 일반 가이드, 리서치 보고서, 매뉴얼 문체로 바꾸면 안 된다.",
    "1인칭이라는 이유로 모든 문장을 '나는', '~해봤다'로 시작하지 않는다. 실제 사람이 쓰듯 주어 생략, 짧은 문장, 설명, 감정, 의문, 관찰을 자연스럽게 섞고 반복 어미를 피한다.",
    "행동·판단·비교·예상 밖 장면이 있으면 그것을 중심으로 쓰되, 정보 설명이 더 자연스러운 대목은 설명으로 쓸 수 있다. 행동 문장과 설명 문장의 비율도 고정하지 않는다.",
    "아직 결과가 없다는 이유로 이미 수행한 행동을 미래형 계획서 말투로 되돌리지 않는다. 반대로 실제로 수행하지 않은 행동까지 완료형으로 꾸미지도 않는다.",
    "성공·실패·오류 발생·해결 여부처럼 Evidence가 필요한 결과는 확인 범위 안에서만 쓴다.",
    "본문의 도입, H2/H3, 전개 순서, 마지막 문단은 어떤 고정 형식도 갖지 않는다. 이전 글과 비슷한 문장 리듬이나 섹션 순서를 재사용하지 않는다.",
    "본문 안에 '편집 상태', '검증용 초안', '발행 보류', '가상의 사용자', '배우', '관찰자' 같은 제작 메타 문구를 넣지 않는다. 운영 상태는 블로그 본문 밖에서만 다룬다.",
  ].join("\n");
}

function evidenceScopeGuardInstructions() {
  return [
    "[Evidence 범위 가드 — 제목/H2/본문/마무리에 모두 적용]",
    "글의 주장 범위는 실제로 확인한 Evidence 환경보다 넓어지면 안 된다. 관심 Problem의 범위와 이번 세션에서 직접 확인한 범위를 구분한다.",
    "Python·코드·파일 도구로 ZIP 내부 문자열이나 메타데이터를 확인한 것은 그 도구 환경에서 ZIP 내부를 확인한 Evidence다. 이것을 Mac Finder나 Windows 파일 탐색기에서 같은 현상을 직접 재현한 것처럼 확대하지 않는다.",
    "브라우저 한 곳, 특정 앱 버전, 특정 파일 하나에서 확인한 결과도 모든 OS·앱·파일에 일반화하지 않는다.",
    "현재 세션에서 코드/파일 도구로 안전하게 직접 검증 가능한 부분이 있고 정보가치가 높다면 실제로 수행해도 된다. 수행했다면 무엇으로 무엇을 확인했는지 본문에 짧게 드러낸다.",
    "직접 확인하지 못한 OS GUI·기기·앱 동작은 OFFICIAL/UNVERIFIED 배경 또는 다음 확인 범위로 남기고 OBSERVED 결과처럼 쓰지 않는다.",
    "블로그 제목, H1, H2, 굵은 핵심 문장, 마지막 판단은 특히 Evidence 범위를 넘지 않게 한다. 넓은 Problem을 선택했더라도 실제 확인이 좁으면 글 제목도 확인한 범위에 맞춰 좁힌다.",
    "예: Problem이 'Mac과 Windows 사이 ZIP 한글 파일명 깨짐'이어도 Python에서 인코딩/정규화만 비교했다면 글은 'ZIP 한글 파일명 깨짐, 인코딩과 자모 분리를 비교해봤다'처럼 직접 확인한 층위를 중심으로 쓴다.",
  ].join("\n");
}

function outputStructureGuardInstructions() {
  return [
    "[출력 구조 회귀 방지]",
    "사용자에게 보여주는 최상위 번호 섹션은 [출력 형식]에 지정된 1~6만 사용한다. 그 사이에 '선정 문제의 직접 비교 결과', '실험 결과', 'Evidence 표' 같은 별도 번호 섹션을 추가하지 않는다.",
    "현재 세션에서 직접 테스트한 결과가 생겼다면 그 Evidence는 문제 해결소 블로그 초안 안의 해당 장면에 자연스럽게 통합한다. 같은 결과를 블로그 앞뒤에서 표와 본문으로 두 번 반복하지 않는다.",
    "비교표가 정말 이해에 필요하면 블로그 초안 안에 한 번만 넣는다. 표 내용을 다시 문단별로 전부 반복하지 않는다.",
    "운영용 정보는 오늘의 판단, 실제 관찰 후 업데이트할 포인트, PROBLEM_MEMORY_JSON에만 남기고 블로그 본문을 보고서처럼 분리하지 않는다.",
  ].join("\n");
}

function plainMarkdownAndArtifactGuardInstructions() {
  return [
    "[본문 형식·제공물 정직성 가드]",
    "블로그 본문과 이미지 계획은 일반 Markdown으로만 작성한다. 서식을 위해 raw HTML, JSX, MDX, XML 스타일 태그를 사용하지 않는다.",
    "금지 예: <text>, </text>, <div>, <span>, <small>, style/color/size 속성, 그리고 이를 이스케이프한 \\\\<text ...\\\\> 형태. &nbsp;, &#x20; 같은 서식용 HTML entity도 직접 출력하지 않는다.",
    "짧은 주석이나 캡션이 필요하면 일반 문장, 괄호, Markdown 이탤릭 등으로 쓴다. 예: '*테스트 환경에서 직접 확인한 값. JSON 시각은 한국시간 기준.*'",
    "글 주제 자체가 HTML/JSX/MDX 코드를 다루는 경우에만 해당 코드를 fenced code block 안의 예제로 표시할 수 있다. 서식이나 메타데이터를 표현하기 위한 태그는 코드 블록 밖에 쓰지 않는다.",
    "현재 응답에서 실제로 생성되어 접근 가능한 파일·링크가 제공되지 않았다면 '첨부했다', '다운로드할 수 있다', '파일 다운로드'라고 쓰지 않는다. 제공물이 없으면 해당 문장을 통째로 생략한다.",
    "실제로 사용자에게 제공 가능한 파일이 생성됐다면 반드시 같은 응답에 실제 접근 가능한 링크나 첨부가 있어야 하며, 없는 링크를 가정하거나 파일명을 다운로드 문구처럼 꾸미지 않는다.",
    "이미지 계획에는 실제로 사용할 캡처 또는 생성 계획만 적는다. 검색 중 발견한 외부 참고 이미지, 썸네일, 제3자 블로그 이미지를 장식용으로 끼워 넣지 않는다.",
    "실제 캡처가 Evidence인 경우 외부 웹 이미지를 대체 증거나 참고 증거처럼 제시하지 않는다. 아직 캡처가 없으면 캡처할 화면과 위치만 설명한다.",
  ].join("\\n");
}

function editorialQualityInstructions() {
  return [
    "[초안 작성 후 편집자 자체 점검 — 품질만 다듬고 구조는 통일하지 않음]",
    "목표 글자 수, 최소·최대 분량, 문단 수, H2/H3 개수, 목록 수, 표 수, 이미지 수를 정하지 않는다. 300자여도 충분하면 끝내고, 실제 경험상 4,000자가 필요하면 그만큼 쓴다.",
    "길이를 어떤 범위에 맞추기 위해 내용을 늘리거나 줄이지 않는다. 반복·군더더기는 삭제하되 실제 경험의 중요한 맥락, 시행착오, 감정, 예상 밖 장면은 길다는 이유로 잘라내지 않는다.",
    "글마다 구조가 달라도 정상이다. 어떤 글은 한 장면으로 끝날 수 있고, 어떤 글은 시간 순서가 중심일 수 있고, 어떤 글은 비교가 중심일 수 있고, 어떤 글은 소제목 없이 이어질 수 있다.",
    "도입 형식을 고정하지 않는다. 문제 장면, 결과, 배경, 의문, 실패, 대화체에 가까운 한 문장 등 실제 글에 맞는 시작을 자유롭게 선택한다.",
    "본문 순서를 고정하지 않는다. 실제 사건 순서가 자연스러우면 그대로 따르고, 독자가 이해하기 위해 일부 맥락을 앞뒤로 옮기는 편이 자연스러우면 그렇게 구성한다.",
    "H2/H3는 0개여도 되고 필요한 만큼 사용해도 된다. 표·목록·인용·짧은 문단도 실제 내용에 도움이 될 때만 사용한다.",
    "마무리 형식을 고정하지 않는다. 해결 결과에서 바로 끝나도 되고, 예상 밖 발견, 아직 남은 의문, 다음 행동, 짧은 소감에서 끝나도 되며 별도의 결론 문단이 없어도 된다.",
    "Story Shape는 운영상 분류일 뿐 블로그의 섹션 순서나 문체를 결정하는 템플릿으로 사용하지 않는다.",
    "이전 글의 제목 패턴, H2 개수, 도입 리듬, 결론 표현을 습관적으로 재사용하지 않는다. 같은 주제군의 글이어도 이번 경험에 맞는 구조를 새로 만든다.",
    "잠정 판단과 실제 검증 결과를 혼동하지 않는다. 아직 확인하지 않은 결과는 결론처럼 단정하지 않는다.",
    "최종 자체 점검은 오직 두 가지다: 군더더기가 남았는가, 그리고 실제 경험의 흐름과 목소리가 살아 있는가. 구조를 다른 글과 맞추는 검사는 하지 않는다.",
  ].join("\n");
}

function imagePlanInstructions() {
  return [
    "[이미지 계획 — 필요한 경우에만]",
    "이미지 수를 정하지 않는다. 0개여도 되고 실제 경험과 이해에 필요하면 그 이상도 가능하다. 개수를 맞추기 위해 이미지를 넣거나 빼지 않는다.",
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
    "글 가치가 있으면 WRITE로 판단하고 QUICK_FIX / TRIAL_AND_ERROR / COMPARISON / DIAGNOSIS / WORKAROUND / NO_SOLUTION 중 실제 사건에 맞는 Story Shape를 운영 메타데이터로 선택할 수 있다. 이 분류가 글의 목차·섹션 순서·문체를 결정하게 하지 않는다.",
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
    evidenceScopeGuardInstructions(),
    outputStructureGuardInstructions(),
    plainMarkdownAndArtifactGuardInstructions(),
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
      "제목·H2·핵심 문장·마지막 판단은 실제 OBSERVED 환경보다 넓게 일반화하지 않는다. 직접 확인한 도구/환경의 범위를 글에서 숨기지 않는다.",
      "현재 세션에서 직접 얻은 Evidence는 블로그 초안에 통합하고 같은 내용을 별도 상위 결과 섹션으로 다시 반복하지 않는다.",
      "블로그 본문과 이미지 계획은 일반 Markdown만 사용한다. 서식용 HTML/JSX/MDX 태그나 HTML entity를 출력하지 않는다.",
      "실제로 제공되지 않은 파일을 첨부·다운로드 가능한 것처럼 쓰지 않고, 이미지 계획에 검색 중 발견한 외부 참고 이미지를 끼워 넣지 않는다.",
      "이미지는 필요한 경우에만 제안하고, 실제 Evidence 스크린샷과 생성 가능한 설명 이미지를 명확히 구분한다. 제안한 이미지는 본문 안의 정확한 위치에도 같은 번호의 삽입 마커를 표시한다.",
    ].join("\n"),
    [
      "[출력 형식]",
      "아래 1~6 외의 추가 최상위 번호 섹션을 만들지 않는다. 직접 실험 결과가 있어도 별도 '직접 비교 결과' 섹션으로 빼지 말고 3번 블로그 초안 안에 녹인다.",
      "1. 오늘의 판단: CONTINUE / NEW / HOLD / NO_GO와 최종 Problem 0~1개. 선택 이유는 핵심만 짧게 설명. Problem 범위가 실제 Evidence보다 넓을 수 있다는 점은 구분",
      "2. 오늘 살펴본 범위: 넓게 본 영역을 2~4줄로 요약하고, 최종 선택 외에 정말 의미 있었던 후보가 있으면 최대 2개만 짧게 표시",
      "3. 문제 해결소 블로그 초안: NEW/CONTINUE이면 반드시 자연스러운 제목과 본문을 작성. 내부 행동 시나리오를 화자 나의 1인칭 체험 서술로 변환하고, 배우·관찰자·한 사용자라는 표현은 본문에서 금지. 리서치/공식 자료는 필요한 만큼만 녹임. 현재 세션에서 도구로 직접 얻은 Evidence가 있으면 이 본문에 통합하고 별도의 결과 보고서로 반복하지 않음. 제목/H2/핵심 판단은 실제 OBSERVED 환경보다 넓게 쓰지 않음. 출력 전 중복·늘어짐을 자체 편집하되 1인칭 체험감과 자유로운 구성은 보존. 본문은 일반 Markdown만 사용하고 서식용 HTML/JSX/MDX/XML 태그나 HTML entity는 금지. 이미지가 필요하면 실제 들어갈 자리마다 '[이미지 N 삽입: 설명 — 종류]' 마커를 본문에 직접 표시. 실제 제공 파일이 없으면 첨부/다운로드 문구를 만들지 않음",
      "4. 이미지 계획: 필요한 경우에만 개수 제한 없이 제안. 본문 마커와 동일한 번호·설명을 사용해 각 항목에 삽입 위치/목적/종류를 적고, 생성 이미지라면 상세 생성 프롬프트를 제공. 실제 화면·오류·전후 Evidence는 '실제 캡처(생성 금지)'로 표시. 외부 참고 이미지나 검색 썸네일은 넣지 않음. 불필요하면 생성 이미지 없음",
      "5. 실제 관찰 후 업데이트할 포인트: 아직 직접 확인하지 못한 환경/장면 또는 최종본에서 반드시 확인해야 할 결과를 최대 3개만 짧게 표시",
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
