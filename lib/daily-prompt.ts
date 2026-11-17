import type {
  DailyPromptMode,
  DailyPromptRecord,
  ProblemRecord,
  SiteProfileRecord,
} from "@/lib/domain";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";
import { ensureSiteProfile } from "@/lib/site-profile";

const ACTIVE_STATUSES = ["IN_PROGRESS", "TESTING", "READY_TO_WRITE", "ARTICLE_READY"];
const PROMPT_VERSION = "daily-session-v5.15";

const EXPLORATION_LENSES = [
  "로그인·인증·계정 복구 과정에서 갑자기 막히는 지점",
  "결제·구독·환불·예약 과정에서 기대와 실제가 어긋나는 지점",
  "사진·영상·문서·파일을 저장·이동·공유할 때 정보가 달라지거나 사라지는 문제",
  "메신저·메일·알림·연락처처럼 사람 사이 정보 전달이 끊기는 문제",
  "지도·교통·여행·체크인·예약처럼 이동 과정에서 생기는 디지털 마찰",
  "스트리밍·자막·오디오·재생처럼 콘텐츠 소비 과정의 반복 불편",
  "스마트폰·PC·브라우저·앱 업데이트 뒤 기본 동작이 달라지는 문제",
  "클라우드·백업·복구·기기 변경 과정에서 생기는 불일치와 누락",
  "AI·검색·생산성 도구가 실제 업무나 일상에서 예상과 다르게 동작하는 문제",
  "공공 웹서비스·온라인 신청·전자문서 제출 과정에서 막히는 문제",
  "스마트홈·Bluetooth·USB·주변기기 연결에서 조건에 따라 달라지는 문제",
  "온라인 쇼핑·배송·멤버십·쿠폰처럼 일상 서비스 사용 중 생기는 작은 실패",
  "개인정보·권한·보안 기본값 때문에 사용자가 이유를 알기 어려운 마찰",
  "반복 작업을 불필요하게 늘리는 워크플로·정리·검색·이름 변경 문제",
  "오프라인·네트워크 전환·다중 기기 환경에서만 나타나는 동작 차이",
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
    "[기존 관심 영역 — 오늘 탐색의 보조 앵커]",
    ...profile.activeScopes.map((scope) => `- ${scope}`),
    "위 목록은 화이트리스트도 오늘 검색의 출발점도 아니다. 오늘 후보의 약 10~15%를 보완하는 Evergreen 앵커로만 사용한다.",
    "오늘의 주제는 먼저 외부 수요 신호와 반복 불편에서 발견한다. 앵커 밖에 더 강한 Problem 신호가 있으면 반드시 앵커 밖 후보를 우선 검토한다.",
    "한 제품명이나 한 OS를 중심으로 후보를 채우지 않는다. 사용자가 하려던 행동과 막힌 지점을 중심으로 Problem을 정의한다.",
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

function buildHistoricalProblemDedupBlock(problems: Array<{ id: string; data: ProblemRecord }>) {
  if (problems.length === 0) return "";

  const rows = [...problems]
    .sort((a, b) => String(b.data.updatedAt ?? "").localeCompare(String(a.data.updatedAt ?? "")))
    .slice(0, 1_000)
    .map((item, index) => {
      const concept = item.data.contentConcept?.slice(0, 120) ?? "";
      return `${index + 1}. ${item.id} | ${item.data.title} | ${item.data.detailArea ?? "미지정"}${concept ? ` | ${concept}` : ""}`;
    });

  return [
    "[전체 Problem 중복 방지 인덱스 — NEW 선택 전 반드시 대조]",
    ...rows,
    "위 인덱스와 같은 사용자 문제·같은 증상·같은 데이터 대상·같은 핵심 원인을 다루는 후보는 제목, 표현, 실험 방법을 바꿔도 NEW로 선택하지 않는다.",
    "새로운 실험 방법이나 다른 글 제목만으로는 새 Problem이 아니다. 기존 Problem이 진행 중이고 실제로 새로운 Evidence를 추가할 수 있을 때만 CONTINUE를 검토한다.",
    "기존 Problem이 이미 PUBLISHED/REJECTED이거나 새 정보가 실질적으로 없으면 그 후보를 버리고 다른 문제를 찾는다.",
    "최종 NEW를 고르기 직전에 이 인덱스와 한 번 더 대조한다.",
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

function externalSignalDiscoveryInstructions() {
  return [
    "[외부 Signal Discovery — 고정 Scope보다 먼저 수행]",
    "오늘의 신규 Problem 탐색은 기존 activeScopes에서 시작하지 않는다. 먼저 현재 사람들이 실제로 검색하고 질문하고 막히는 외부 신호를 넓게 수집한다.",
    "가능하면 다음 네 축을 함께 본다: Google Trends의 Trending Now/Explore, 네이버 데이터랩 검색어 트렌드 또는 네이버 검색 신호, Reddit·포럼·Q&A·커뮤니티의 반복 질문, 공식 도움말·릴리스 노트·상태/이슈 문서의 최근 변화.",
    "Google Trends는 '지금 관심이 급증한 영역을 발견하는 레이더'로 사용한다. 뉴스·연예·정치·스포츠처럼 Problem 해결소와 무관한 단순 화제는 버리고, 일반 사용자가 직접 겪는 디지털 문제로 변환 가능한 신호만 남긴다.",
    "네이버 데이터랩이나 네이버 검색 신호는 한국 사용자 관심도를 보조 검증하는 용도로 사용한다. API나 페이지 접근이 불가능하면 이를 필수 조건으로 만들지 말고 다른 신호로 계속 탐색한다.",
    "검색량이 높다는 이유만으로 Problem을 선택하지 않는다. Trends/DataLab은 발견과 동률 후보의 우선순위 판단에만 사용하며, 반복되는 실제 불편·직접 검증 가능성·새 Evidence 가치가 더 중요하다.",
    "외부 신호에서 제품명만 추출하지 말고 '무엇을 하려다 무엇이 안 됐는가' 형태로 Problem Territory를 만든다. 예: '카카오톡'이 아니라 '기기 변경 뒤 채팅 백업이 일부 보이지 않는 문제'.",
    "급상승 검색어가 너무 사건성이라면 관련 검색어·자동완성·질문형 검색을 확장해 실제 사용 문제를 찾는다. '안됨', '오류', '사라짐', '느림', '변경', '로그인', '결제', '다운로드', '백업', '연동', '업데이트 후' 같은 문제 표현을 함께 탐색한다.",
    "내부 후보 비중의 기본값은 외부 실시간 수요 신호 약 40%, 커뮤니티 반복 문제 약 25%, 기존 범위 밖 인접·무작위 탐색 약 20%, 기존 activeScopes 약 15%다. 이것은 정확한 quota가 아니라 앵커 편향을 막는 방향 가이드다.",
    "최종 후보를 고르기 전 Firestore 전체 Problem 중복 인덱스와 대조한다. 이미 다룬 문제라면 관심도가 다시 올라도 새 Problem으로 만들지 않는다.",
  ].join("\n");
}

function discoveryInstructions() {
  return [
    "[오늘의 모드: SIGNAL_FIRST_BROAD_DISCOVERY]",
    "처음부터 특정 제품·OS·파일 형식을 고르지 않는다. Google Trends/네이버 검색·데이터랩/커뮤니티/공식 변화 신호를 먼저 훑고 오늘 실제로 올라오는 문제 영역을 찾는다.",
    "1차 탐색에서는 최소 10개, 가능하면 12~15개의 서로 다른 Problem Territory를 만든다. 한 회사·한 OS·한 앱 생태계가 전체 후보의 20%를 넘지 않게 한다.",
    "기존 activeScopes는 후보를 보완하는 10~15% 수준의 Evergreen 앵커로만 사용한다. 앵커와 무관한 신호라도 일반 사용자가 직접 겪고 검증 가능한 디지털 문제라면 적극 포함한다.",
    "제품명보다 사용자 행동을 기준으로 후보를 분산한다. 로그인/인증, 결제/예약, 이동/지도, 사진/영상, 문서/파일, 메신저/알림, 스트리밍, 백업/복구, 스마트기기, 공공서비스, 생산성, 온라인 쇼핑 등 서로 다른 생활 장면을 섞는다.",
    "급상승 검색어 자체를 글 주제로 쓰지 않는다. 반복되는 사용자 불편으로 변환할 수 없으면 버린다.",
    "1차 후보를 만든 뒤에만 반복 신호, Evergreen, 직접 검증 가능성, 독자 결과 가치, 독창적 Evidence 가능성, 검색 결과 포화도를 비교해 5개 이하로 좁힌다.",
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
    "[운영용 데이터 — 블로그/WordPress 본문과 완전히 분리]",
    "Daily Research 답변의 모든 사용자용 콘텐츠가 끝난 뒤 수평선 '---'을 넣고, 번호 없는 '운영용 데이터 — WordPress에 복사하지 않음' 문구를 표시한다.",
    "그 아래에 'PROBLEM_MEMORY_JSON'을 일반 텍스트 라벨로 한 번만 표시하고, 바로 다음에 JSON 코드 블록 하나만 출력한다.",
    "PROBLEM_MEMORY_JSON에는 H2/H3나 '6.' 같은 번호를 붙이지 않는다. 블로그 초안, 이미지 계획, 실제 관찰 후 업데이트할 포인트와 같은 콘텐츠 섹션처럼 보이게 만들지 않는다.",
    "이 JSON은 Notion의 '선택 결과 JSON' 속성에 붙여넣어 Firestore Problem 기억으로 반영하는 운영 메타데이터이며 WordPress 글에는 복사하지 않는다.",
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
    "현재 세션에서 실제로 수행한 행동만 1인칭 완료형으로 쓴다. 웹 검색·공식 문서 확인·파일 생성·코드 실행·앱 조작 등 실제로 한 행동은 그대로 경험 서술에 사용할 수 있지만, 내부 시나리오에만 있고 실제 수행하지 않은 행동은 완료형으로 꾸미지 않는다.",
    "특정 어미, 문장 패턴, 반복 표현을 템플릿처럼 고정하지 않는다. 주제와 실제 행동에 맞는 말투를 매번 새로 선택한다.",
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

function evidenceDensityInstructions() {
  return [
    "[Evidence 밀도 가드 — 글의 길이와 완성도는 실제 경험량이 결정]",
    "1인칭처럼 보이게 만들기 위해 글을 늘리지 않는다. 현재 세션에서 실제로 확보한 OBSERVED 행동·결과의 양이 블로그 본문의 길이, 구체성, 완성도를 결정한다.",
    "직접 Evidence가 적고 공식 문서·커뮤니티 확인이 대부분이라면 짧은 확인 기록으로 끝내도 된다. 완성된 장문 후기처럼 보이게 배경 설명, 사용법, 가설, 다음 계획을 덧붙여 분량을 채우지 않는다.",
    "공식 도움말을 읽은 것은 '공식 도움말을 확인해봤다'는 실제 1인칭 경험으로 쓸 수 있다. 그러나 공식 문서에 적힌 1~4단계 절차를 내가 직접 실행한 것처럼 바꾸지 않는다.",
    "실제로 앱·파일·브라우저를 조작하지 않았다면 해당 사용법을 긴 튜토리얼 섹션으로 재작성하지 않는다. 지금 판단에 꼭 필요한 차이만 짧게 요약하고, 직접 실행 결과는 미확인으로 남긴다.",
    "반대로 실제 파일 생성, 코드 실행, 앱 조작, 전후 비교, 실패와 재시도 같은 OBSERVED 장면이 충분하면 그 장면을 필요한 만큼 자세히 써도 된다. 길다는 이유로 실제 경험을 줄이지 않는다.",
    "OFFICIAL/커뮤니티 근거의 양이 많아도 OBSERVED 경험량이 적으면 글을 길게 만들 근거가 되지 않는다. 리서치 양과 블로그 분량을 연결하지 않는다.",
    "글이 짧다고 미완성처럼 보이게 만들 필요가 없다. '여기까지 직접 확인했다'는 범위에서 자연스럽게 끝날 수 있으며, 다음 검증 계획은 필요할 때 블로그 밖의 업데이트 포인트에 남긴다.",
    "출력 전 마지막으로 확인한다: 이 문장은 내가 실제로 한 행동·확인한 결과인가, 아니면 글을 풍성하게 보이게 하려고 공식 자료나 계획을 경험처럼 늘린 것인가? 후자라면 삭제하거나 범위를 명확히 낮춘다.",
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
    "Daily Research의 리서치 판단과 운영 정보, WordPress 게시 패키지를 명확히 분리한다.",
    "현재 세션에서 직접 테스트한 Evidence는 게시용 본문 안의 해당 장면에 자연스럽게 통합한다. 같은 결과를 별도 결과 보고서와 본문에서 반복하지 않는다.",
    "비교표가 정말 이해에 필요하면 게시용 본문 안에 한 번만 넣는다. 표 내용을 다시 문단별로 전부 반복하지 않는다.",
    "최종 NEW/CONTINUE 응답에는 auto-publisher-web이 인식할 수 있는 정확한 게시 패키지 구조를 한 번만 출력한다.",
    "게시 패키지의 '# 1. 게시용 본문' 안에는 WordPress에 실제 들어갈 H1 제목과 본문만 넣는다. 오늘의 판단, 후보 비교, 운영 상태, PROBLEM_MEMORY_JSON은 게시용 본문 안에 넣지 않는다.",
    "HOLD/NO_GO이면 억지로 게시 패키지를 만들지 않는다. 판단과 운영용 JSON만 출력한다.",
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
    "[이미지 계획 — 본문 Evidence 이미지는 필요한 경우에만]",
    "본문에 들어가는 Evidence/설명 이미지는 개수를 정하지 않는다. 0개여도 되고 실제 경험과 이해에 필요하면 필요한 만큼 사용한다.",
    "본문 이미지를 제안하면 '삽입 위치 / 목적 / 종류'를 적고 게시용 본문 안의 정확한 위치에도 '[이미지 N 삽입: 짧은 설명 — 실제 캡처]' 또는 '[이미지 N 삽입: 짧은 설명 — 생성 이미지]' 마커를 넣는다.",
    "실제 제품 화면, 오류 메시지, 전후 비교처럼 Evidence 역할을 하는 이미지는 AI로 만들지 않는다. 실제 캡처 계획만 적는다.",
    "대표 썸네일은 Evidence 이미지와 별개다. NEW/CONTINUE이면 글마다 '# 3. 대표 이미지 생성 프롬프트'에 복사/붙여넣기 가능한 썸네일 제작 프롬프트를 반드시 한 개 만든다.",
    "대표 썸네일 프롬프트는 실제 주제에 맞는 배경 사진/개념 이미지를 먼저 구성하고, 그 위에 로열블루 계열의 반투명 필터를 약 55~68% 강도로 덮어 배경이 은은하게 보이게 한다.",
    "첨부 예시와 같은 강한 에디토리얼 썸네일을 목표로 한다: 가로형 16:10 안팎, 상단 중앙에 작은 흰색 pill 형태의 카테고리 라벨, 중앙~하단에 굵고 큰 흰색 한글 핵심 문구 2~3줄, 넉넉한 여백, 높은 대비, 모바일에서도 읽히는 타이포그래피.",
    "배경은 글의 실제 주제를 상징하는 사진 또는 개념 장면이어야 한다. 존재하지 않는 제품 UI, 가짜 오류 화면, 가짜 실험 결과를 만들지 않는다.",
    "본문 제목 전체를 썸네일에 억지로 넣지 않는다. 의미를 왜곡하지 않는 짧은 핵심 문구로 압축하고, 한 줄이 너무 길지 않게 2~3줄로 나눈다.",
    "생성 모델이 한글을 임의로 바꾸지 않도록 프롬프트 안에 '아래 한글 문구를 철자와 띄어쓰기까지 정확히 렌더링하고 다른 문구를 추가하지 말 것'을 명시한다.",
    "우측 상단은 향후 로고를 별도로 얹을 수 있도록 비워 둔다. 원본 로고 파일이 제공되지 않은 상태에서 임의 로고나 가짜 브랜드 마크를 생성하지 않는다.",
    "대표 이미지 프롬프트 뒤에는 '대체 텍스트: ...' 한 줄을 별도로 출력한다. 대체 텍스트는 이미지의 주제와 시각 구성을 자연스럽게 설명하고 키워드를 억지로 반복하지 않는다.",
  ].join("\n");
}

function wordpressPublicationPackageInstructions() {
  return [
    "[auto-publisher-web 호환 WordPress 게시 패키지 — NEW/CONTINUE에서 필수]",
    "사용자가 응답 전체를 https://auto-publisher-web.vercel.app/wordpress 에 그대로 복사/붙여넣어도 게시 제목과 SEO 메타데이터가 자동 추출되도록 아래 구조와 라벨을 정확히 사용한다.",
    "게시 패키지는 응답 안에서 한 번만 출력한다. 다른 섹션에서 같은 '# 1. 게시용 본문' 또는 '# 4. Rank Math SEO 패키지'를 반복하지 않는다.",
    "정확한 구조:",
    "# 1. 게시용 본문",
    "<!-- 게시용 본문 시작 -->",
    "# 실제 WordPress 게시 제목",
    "자유로운 블로그 본문",
    "<!-- 게시용 본문 끝 -->",
    "# 2. 게시 전 확인 자료",
    "실제 관찰 후 업데이트 포인트와 아직 미검증인 범위를 짧게 정리. WordPress 본문에는 포함되지 않는 운영 참고 영역.",
    "# 3. 대표 이미지 생성 프롬프트",
    "복사/붙여넣기용 썸네일 이미지 생성 프롬프트를 text 코드 블록 하나로 출력.",
    "코드 블록 다음 줄에 '대체 텍스트: 실제 대체 텍스트'를 출력.",
    "# 4. Rank Math SEO 패키지",
    "아래 각 메타 라벨은 정확히 H2로 쓰고 각 값은 별도의 fenced code block 하나에 넣는다.",
    "## 포커스 키워드",
    "## SEO title",
    "## 영문 퍼머링크",
    "## SEO description",
    "## 글 태그",
    "## 카테고리명",
    "영문 퍼머링크는 소문자 영문/숫자/하이픈만 사용하고 의미가 통하는 짧은 slug로 만든다.",
    "글 태그는 쉼표로 구분한 3~8개 정도의 실제 관련 태그로 만든다.",
    "카테고리명은 auto-publisher-web의 현재 기본 카테고리와 정확히 자동 매칭되도록 IT·AI / 경제·재테크·투자 / 생활·실용정보 / 취업·자격증·직무 중 가장 맞는 하나만 출력한다.",
    "PROBLEM_MEMORY_JSON의 category는 Problem 기억용 세부 분류이므로 위 WordPress 카테고리명과 달라도 정상이다.",
    "SEO title은 실제 글과 일치하고 과장하지 않는다. SEO description은 실제 확인 범위를 넘지 않으며 자연스러운 한두 문장으로 작성한다.",
    "포커스 키워드는 검색자가 실제 입력할 법한 핵심 검색어 하나를 사용한다.",
    "이 메타 블록은 블로그 본문이 아니며 '# 1. 게시용 본문' 안에 섞지 않는다.",
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
    listDocuments<ProblemRecord>("problems", 1_000),
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
    externalSignalDiscoveryInstructions(),
    buildDailyLensBlock(dateKey),
    buildAnchorBlock(profileDoc.data),
    mode === "CONTINUATION_FIRST" ? continuationInstructions() : discoveryInstructions(),
    buildActiveProblemsBlock(activeProblems),
    buildHistoricalProblemDedupBlock(problemDocs),
    buildProblemMemoryBlock(problemDocs),
    buildRejectionBlock(rejections),
    buildArticleBlock(articles),
    [
      "[웹 조사 순서]",
      "1. Google Trends Trending Now/Explore, 네이버 검색·데이터랩, 커뮤니티/Q&A를 이용해 오늘의 외부 Signal을 먼저 넓게 훑는다. 특정 제품명으로 시작하지 않는다.",
      "2. Signal을 '사용자가 무엇을 하려다 무엇이 안 됐는가' 형태의 Problem Territory로 변환한다. 뉴스성·인물성·일회성 화제는 제외한다.",
      "3. 커뮤니티·질문·포럼에서 같은 불편이 서로 다른 사용자에게 반복되는지 확인한다. 단일 바이럴 글이나 뉴스 한 건만으로 후보를 올리지 않는다.",
      "4. 공식 도움말·릴리스 노트·상태/이슈 문서에서 현재 동작이나 최근 변경을 확인하되, 공식 문서 자체를 사용자 불편의 반복 증거로 취급하지 않는다.",
      "5. 2차 후보만 더 깊게 검색한다. Trends/DataLab 수치는 tie-breaker로만 쓰고, 이미 해결 글이 과도하게 많아 새 Evidence 가치가 낮으면 감점한다.",
      "6. Firestore 전체 Problem 중복 인덱스와 다시 대조해 같은 문제면 NEW에서 제거한다.",
      "7. 내가 직접 재현할 수 없는 장비·계정·유료 서비스가 필수라면 HOLD 또는 제외한다.",
      "8. 의료·법률·투자·안전처럼 고위험 판단이 필요한 영역은 제외한다.",
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
    evidenceDensityInstructions(),
    evidenceScopeGuardInstructions(),
    outputStructureGuardInstructions(),
    plainMarkdownAndArtifactGuardInstructions(),
    editorialQualityInstructions(),
    imagePlanInstructions(),
    wordpressPublicationPackageInstructions(),
    storySeedInstructions(),
    postEvidenceNaturalBlogInstructions(),
    [
      "[출력 원칙]",
      "내부적으로는 10~15개 Problem Territory를 넓게 만들고 상위 후보를 검증하되, 사용자에게 그 전체 목록을 보고서처럼 모두 펼치지 않는다.",
      "리서치 설명은 짧게 유지하고, 응답의 중심은 1인칭 체험형 블로그 초안이 되게 한다. 표와 점수표는 비교에 꼭 필요할 때만 사용한다.",
      "내부 행동 시나리오, 기록할 Evidence, Story Seed를 각각 긴 운영 섹션으로 반복하지 말고 블로그 초안 안에 자연스럽게 녹인다.",
      "블로그 본문에는 배우·관찰자·한 사용자라는 표현을 노출하지 않는다. 운영 정보보다 현재 세션에서 실제로 내가 수행한 행동과 확인한 결과가 중심이 되어야 한다.",
      "실제 OBSERVED 경험이 적으면 글도 짧아야 한다. 공식 문서·커뮤니티·향후 계획으로 장문 체험 후기처럼 부풀리지 않는다.",
      "초안을 출력하기 전에 중복 문단과 억지 분량을 편집자 관점에서 한 번 더 줄이되, 실제 1인칭 체험형 행동 흐름은 절대 일반 가이드 말투로 약화시키지 않는다.",
      "제목·H2·핵심 문장·마지막 판단은 실제 OBSERVED 환경보다 넓게 일반화하지 않는다. 직접 확인한 도구/환경의 범위를 글에서 숨기지 않는다.",
      "현재 세션에서 직접 얻은 Evidence는 블로그 초안에 통합하고 같은 내용을 별도 상위 결과 섹션으로 다시 반복하지 않는다.",
      "블로그 본문과 이미지 계획은 일반 Markdown만 사용한다. 서식용 HTML/JSX/MDX 태그나 HTML entity를 출력하지 않는다.",
      "실제로 제공되지 않은 파일을 첨부·다운로드 가능한 것처럼 쓰지 않고, 이미지 계획에 검색 중 발견한 외부 참고 이미지를 끼워 넣지 않는다.",
      "이미지는 필요한 경우에만 제안하고, 실제 Evidence 스크린샷과 생성 가능한 설명 이미지를 명확히 구분한다. 제안한 이미지는 본문 안의 정확한 위치에도 같은 번호의 삽입 마커를 표시한다.",
    ].join("\n"),
    [
      "[출력 형식]",
      "NEW/CONTINUE이면 아래 순서를 사용한다. 조사 판단과 운영 정보는 게시용 본문에 섞지 않고, WordPress에 넣을 글은 auto-publisher-web 호환 패키지 안에 한 번만 둔다.",
      "A. 오늘의 판단: CONTINUE / NEW와 최종 Problem 1개, 선택 이유와 실제 Evidence 범위를 짧게 설명",
      "B. 오늘 살펴본 범위: 넓게 본 영역을 2~4줄로 요약하고 정말 의미 있었던 대안이 있으면 최대 2개만 표시",
      "C. WordPress 게시용 결과물: 반드시 '# 1. 게시용 본문' → '# 2. 게시 전 확인 자료' → '# 3. 대표 이미지 생성 프롬프트' → '# 4. Rank Math SEO 패키지' 순서로 출력",
      "'# 1. 게시용 본문'에는 실제 H1 제목과 자연스러운 1인칭 본문만 넣는다. 현재 세션에서 실제로 수행한 행동만 완료형으로 쓰고, 직접 Evidence가 적으면 짧게 끝내도 된다.",
      "'# 2. 게시 전 확인 자료'에는 아직 실제로 확인하지 못한 환경/장면 또는 최종본에서 확인해야 할 결과를 최대 3개만 짧게 적는다. 이 내용은 auto-publisher-web에서 WordPress 본문으로 추출되지 않는다.",
      "'# 3. 대표 이미지 생성 프롬프트'에는 주제 맞춤 배경 + 55~68% 반투명 로열블루 오버레이 + 흰색 category pill + 굵은 흰색 한글 핵심 문구 2~3줄 + 우측 상단 로고 여백을 포함한 복사/붙여넣기용 프롬프트를 text 코드 블록으로 출력하고, 다음 줄에 대체 텍스트를 적는다.",
      "'# 4. Rank Math SEO 패키지'에는 포커스 키워드 / SEO title / 영문 퍼머링크 / SEO description / 글 태그 / 카테고리명을 정확한 H2 라벨과 fenced 값으로 출력한다.",
      "D. 실제 관찰 후 업데이트할 포인트: # 2와 중복 보고서를 만들지 않는다. 추가 설명이 필요 없으면 생략하거나 한 문장만 둔다.",
      "HOLD/NO_GO이면 WordPress 게시용 결과물을 만들지 않는다. 오늘의 판단과 짧은 이유만 사용자용으로 출력한다.",
      "사용자용 콘텐츠가 끝난 뒤 '---' 수평선을 넣고 번호 없는 '운영용 데이터 — WordPress에 복사하지 않음' → 'PROBLEM_MEMORY_JSON' → JSON 코드 블록 순서로 끝낸다.",
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
