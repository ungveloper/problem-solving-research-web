import type {
  DailyPromptMode,
  DailyPromptRecord,
  ProblemRecord,
  SiteProfileRecord,
} from "@/lib/domain";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";
import { ensureSiteProfile } from "@/lib/site-profile";

const ACTIVE_STATUSES = ["IN_PROGRESS", "TESTING", "READY_TO_WRITE", "ARTICLE_READY"];

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

function koreaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildScopeBlock(profile: SiteProfileRecord) {
  return [
    "[현재 탐색 범위]",
    ...profile.activeScopes.map((scope) => `- ${scope}`),
    "현재 범위와 자연스럽게 연결되는 인접 문제는 후보로 볼 수 있지만, 전혀 다른 분야로 갑자기 확장하지 않는다.",
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
        `   연속성: ${item.data.storyMode ?? "ONE_SHOT"}`,
        item.data.whyRecommended ? `   배경: ${item.data.whyRecommended}` : "",
      ].filter(Boolean).join("\n"),
    ),
    "진행 중인 문제가 오늘 이어서 확인할 가치가 있으면 새 문제를 억지로 만들지 말고 CONTINUE를 우선한다.",
  ].join("\n");
}

function buildRejectionBlock(rejections: Array<{ id: string; data: RejectionRecord }>) {
  if (rejections.length === 0) return "";
  return [
    "[과거 반려 기억 — 다시 추천하지 않기]",
    ...rejections.slice(0, 20).map((item, index) =>
      `${index + 1}. ${item.data.title ?? "제목 없음"} / 범위: ${item.data.scope ?? "CLUSTER"} / 이유: ${item.data.reason ?? "기타"}`,
    ),
    "EXACT는 같은 문제를, CLUSTER는 같은 문제 의도를, SCOPE는 해당 영역 자체를 다시 추천하지 않는다.",
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
    "[오늘의 모드: DISCOVERY]",
    "최신 웹을 직접 검색해서 사람들이 실제로 반복해서 겪는 작은 문제를 찾는다.",
    "뉴스 자체를 요약할 주제를 찾지 말고, 시간이 지나도 다시 검색될 가능성이 있는 문제를 찾는다.",
    "가능하면 서로 다른 출처에서 같은 문제가 반복되는지 확인한다.",
    "한국 사용자의 실제 표현을 우선하되 해외의 반복 문제도 한국에서 직접 재현 가능한 경우 후보로 포함할 수 있다.",
  ].join("\n");
}

function continuationInstructions() {
  return [
    "[오늘의 모드: CONTINUATION_FIRST]",
    "진행 중인 문제를 먼저 검토한다.",
    "어제/이전 결과를 반복하지 말고 다음으로 원인을 좁힐 행동이 있는지 판단한다.",
    "진행 중 문제에 오늘 할 가치가 있는 다음 행동이 없을 때만 신규 문제 탐색으로 넘어간다.",
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
      "당신은 '문제 해결소'의 오늘 문제 조사자이자 미션 설계자다.",
      "이 대화에서는 먼저 최신 웹을 조사하고 오늘 직접 확인할 문제를 고른다. 실제 Evidence가 생기기 전에는 최종 1인칭 경험담을 쓰지 않는다.",
      `기준 날짜: ${dateKey} (Asia/Seoul)`,
    ].join("\n"),
    buildPrincipleBlock(profileDoc.data),
    buildScopeBlock(profileDoc.data),
    mode === "CONTINUATION_FIRST" ? continuationInstructions() : discoveryInstructions(),
    buildActiveProblemsBlock(activeProblems),
    buildRejectionBlock(rejections),
    buildArticleBlock(articles),
    [
      "[웹 조사 규칙]",
      "- 반드시 현재 웹을 검색해서 실제 출처를 확인한다. 검색하지 않았다면 검색한 것처럼 말하지 않는다.",
      "- 커뮤니티/질문/이슈에서 반복되는 문제 신호와 공식 문서의 현재 해결 정보를 구분한다.",
      "- 단순 정의, 뉴스 요약, 제품 추천, 구매 가이드보다 직접 재현 가능한 문제 해결을 우선한다.",
      "- 의료·법률·투자처럼 높은 위험의 주제는 초기 범위에서 제외한다.",
      "- 검색 결과가 이미 충분히 잘 해결하고 있거나 내가 직접 검증할 수 없으면 낮게 평가한다.",
    ].join("\n"),
    [
      "[후보 판단 기준]",
      "반복성 / Evergreen / 직접 검증 가능성 / 독자 결과 가치 / 독창적 Evidence 생성 가능성 / 기존 글과의 비중복성을 함께 본다.",
      "점수를 억지로 높이지 않는다. 오늘 발행 가치가 있는 신규 Problem이 0개여도 정상이다.",
    ].join("\n"),
    [
      "[출력 형식]",
      "1. 오늘의 판단: CONTINUE / NEW / HOLD / NO_GO 중 하나",
      "2. 조사 근거: 실제 확인한 웹 출처와 반복 신호를 짧게 요약",
      "3. 후보가 있다면 최대 3개까지만 제시하고 각각 왜 직접 해볼 가치가 있는지 설명",
      "4. 최종 선택은 1개 이하. 가치가 부족하면 '오늘은 진행할 신규 문제 없음'이라고 명시",
      "5. 선택했다면 오늘 직접 할 Mission을 구체적인 행동 순서로 작성",
      "6. 기록해야 할 Evidence를 최소한으로 제시 (성공/실패, 환경, 오류 문구, 전후 차이 등)",
      "7. 하루에 끝나지 않을 경우 N일차의 미래 결과는 쓰지 말고 다음 행동 계획만 제시",
      "8. 여기서 멈춘다. 사용자가 실제 결과를 알려주기 전에는 최종 블로그 글을 작성하지 않는다.",
    ].join("\n"),
    [
      "[사용자가 Evidence를 준 이후의 규칙]",
      "사용자가 실제 테스트 결과를 보내면 그 Evidence와 확인 가능한 공식 자료를 분리해 판단한다.",
      "그때 최종 글이 필요하다고 요청받으면 사건 흐름에 맞는 자연스러운 개인 블로그 글로 작성한다.",
      "H2는 실제 내용 전환에 필요할 때만 사용하고, FAQ/표/체크리스트/내부 링크/결론을 기본 형식으로 강제하지 않는다.",
      "실제로 하지 않은 행동은 절대 추가하지 않는다.",
    ].join("\n"),
  ].filter(Boolean);

  return { prompt: blocks.join("\n\n"), mode };
}

export async function ensureDailyPrompt(dateKey = koreaDateKey()) {
  const id = `daily-${dateKey}`;
  const existing = await getDocument<DailyPromptRecord>("dailyPrompts", id);
  if (existing) return { ...existing, created: false };

  const { prompt, mode } = await composeDailySessionPrompt(dateKey);
  const now = new Date().toISOString();
  const record: DailyPromptRecord = {
    title: `${dateKey} 오늘의 문제 조사 프롬프트`,
    dateKey,
    status: "RECOMMENDED",
    mode,
    prompt,
    promptVersion: `daily-session-v1-${mode.toLowerCase()}`,
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
