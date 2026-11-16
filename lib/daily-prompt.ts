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
        item.data.missionSummary ? `   최근 직접 해볼 일: ${item.data.missionSummary}` : "",
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
    "NEW이면 title/category/detailArea/concept/whyRecommended/missionSummary/storySeed를 채운다.",
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

function storySeedInstructions() {
  return [
    "[Story Seed — 글 초안이 아님]",
    "Evidence 전에 블로그 본문, 제목, H2 구조, 결론을 만들지 않는다.",
    "대신 실제로 해보면서 기억해 둘 만한 장면과 변화만 3~5줄의 Story Seed로 남긴다.",
    "예: 처음 이상함을 발견한 순간 / 예상과 달랐던 변화 / 실패 뒤 바꿔본 한 가지 / 전후 차이를 보여주는 화면이나 시간.",
    "Story Seed는 미래 경험을 지어내는 문장이 아니라 '이런 장면이 실제로 생기면 기록한다'는 관찰 포인트다.",
    "아무 변화도 없거나 공식 문서와 똑같은 결과만 나오면 그것도 기록하고, 글을 억지로 만들지 않는다.",
  ].join("\n");
}

function postEvidenceNaturalBlogInstructions() {
  return [
    "[Evidence 이후에만 Natural Blog 단계로 전환]",
    "사용자가 실제로 해본 결과를 보내기 전에는 블로그 글을 작성하지 않는다.",
    "결과를 받으면 먼저 각 내용을 OBSERVED / OFFICIAL / INFERRED / UNVERIFIED로 분리한다.",
    "그 다음 이 경험이 독자에게 새롭게 전달할 가치가 있는지 WRITE / RECORD_ONLY 중 하나로 판단한다.",
    "공식 문서 그대로였고 새 Evidence가 없거나, 관찰이 너무 약해 독립 글 가치가 없으면 RECORD_ONLY로 남기고 글을 만들지 않는다.",
    "실패, 재현 실패, 해결되지 않음도 조건과 관찰이 분명해 독자에게 도움이 되면 WRITE가 될 수 있다.",
    "WRITE일 때만 실제 사건의 순서를 보고 QUICK_FIX / TRIAL_AND_ERROR / COMPARISON / DIAGNOSIS / WORKAROUND / NO_SOLUTION 중 가장 맞는 Story Shape를 선택한다.",
    "최종 글은 Daily Research의 섹션, 후보 순위, Mission 순서, Evidence 표를 복사하지 않는다.",
    "문제→원인→해결→결론, 매번 같은 H2, FAQ, 표, 체크리스트, 고정 도입·결론을 기본 구조로 쓰지 않는다.",
    "실제로 있었던 장면과 행동 순서를 우선한다. 한 번에 해결됐으면 짧게 끝내고, 여러 번 실패했다면 그 실패가 이야기의 중심이 될 수 있다.",
    "1인칭 경험 문장은 OBSERVED에만 사용한다. OFFICIAL과 INFERRED는 실제 경험과 섞어 사실처럼 만들지 않는다.",
    "'이번 글에서는', '정리하면', '결론적으로' 같은 습관적 문구를 필요 없이 반복하지 않는다.",
    "스크린샷, 표, 목록, 내부 링크, 이미지는 실제 이해나 증거에 도움이 될 때만 사용한다.",
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
      "Daily Research는 글쓰기 단계가 아니다. 실제 Evidence가 생기기 전에는 블로그 본문을 만들지 말고, 오늘 직접 확인할 Problem과 최소 행동, 관찰 포인트만 정한다.",
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
    storySeedInstructions(),
    postEvidenceNaturalBlogInstructions(),
    [
      "[출력 원칙]",
      "내부적으로는 10~15개 Problem Territory를 넓게 만들고 상위 후보를 검증하되, 사용자에게 그 전체 목록을 보고서처럼 모두 펼치지 않는다.",
      "최종 출력은 짧고 실행 중심으로 만든다. 표와 점수표는 비교에 꼭 필요할 때만 사용한다.",
      "리서치 과정 자체를 콘텐츠처럼 길게 보여주는 것보다 오늘 무엇을 해볼지가 분명해야 한다.",
    ].join("\n"),
    [
      "[출력 형식]",
      "1. 오늘의 판단: CONTINUE / NEW / HOLD / NO_GO와 최종 Problem 0~1개. 왜 지금 직접 확인할 가치가 있는지만 짧게 설명",
      "2. 오늘 살펴본 범위: 넓게 본 영역을 3~5줄로 요약하고, 최종 선택 외에 의미 있었던 다른 후보는 최대 2개만 짧게 표시",
      "3. 오늘 직접 해볼 것: 검증 관점 하나를 바탕으로 3~6개의 현실적인 행동. 연구소식 용어보다 실제 사용자가 그대로 할 수 있는 표현을 우선",
      "4. 기록할 것: 성공/실패, 환경, 오류 문구, 시간, 전후 차이 중 이번 Problem에 정말 필요한 Evidence만 최소화",
      "5. Story Seed: 아직 글을 쓰지 말고, 실제로 생기면 기록할 만한 장면·변화·예상 밖 결과를 3~5줄",
      "6. Evidence를 받은 뒤의 규칙: 먼저 WRITE / RECORD_ONLY 판단, WRITE일 때만 Story Shape를 뒤늦게 고르고 Natural Blog 작성",
      "7. PROBLEM_MEMORY_JSON: 답변 맨 마지막에 운영 DB 반영용 JSON 코드 블록 출력",
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
