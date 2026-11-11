import { normalizeKey, type ProblemMode, type StoryMode } from "@/lib/domain";
import { listDocuments } from "@/lib/firestore";

type Article = {
  title?: string;
  url?: string;
  categoryNames?: string[];
  excerptText?: string;
  searchText?: string;
  modifiedAt?: string;
};

type Rejection = {
  title?: string;
  category?: string;
  reason?: string;
  scope?: string;
  active?: boolean;
};

function tokenSet(input: string) {
  return new Set(normalizeKey(input).split("-").filter((token) => token.length >= 2));
}

function overlapScore(left: string, right: string) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function modeInstructions(mode: ProblemMode) {
  switch (mode) {
    case "CONTINUE":
      return [
        "이 문제는 새 글감이 아니라 진행 중인 문제의 다음 단계다.",
        "이전 결과를 뒤집거나 반복하지 말고, 다음 행동이 왜 필요한지 연결해서 판단한다.",
        "하루 만에 끝나지 않으면 미래의 결과를 지어내지 말고 다음 미션만 설계한다.",
      ];
    case "UPDATE":
      return [
        "기존 글을 새 글로 복제하지 않는다.",
        "현재 버전이나 환경 변화 때문에 기존 해결법을 다시 검증할 가치가 있는지 먼저 판단한다.",
        "업데이트가 충분하면 UPDATE_EXISTING, 독립 검색 의도가 분명하면 NEW로 구분한다.",
      ];
    case "EXPAND":
      return [
        "현재 블로그와 자연스럽게 인접하지만 아직 덜 다룬 문제 영역을 찾는다.",
        "갑자기 전혀 다른 분야로 확장하지 않는다.",
        "새 영역은 사용자가 직접 재현하거나 확인할 수 있는 문제 해결형이어야 한다.",
      ];
    default:
      return [
        "후보가 기존 글과 실질적으로 같은 검색 의도인지 먼저 확인한다.",
        "새 문제라면 직접 테스트 가능한 최소 미션을 설계한다.",
        "문제를 억지로 연재하지 말고 실제로 여러 날이 필요한 경우에만 Mission Arc를 제안한다.",
      ];
  }
}

function storyInstructions(storyMode?: StoryMode) {
  if (storyMode === "LIVING_LOG") {
    return "같은 URL에 며칠간 실제 결과를 누적하는 Living Log 관점으로 다음 행동만 설계한다.";
  }
  if (storyMode === "SERIES") {
    return "각 날짜가 독립적인 검색 가치를 가질 때만 시리즈로 나눈다. 날짜 채우기용 글은 만들지 않는다.";
  }
  return "하루 안에 해결할 수 있으면 짧게 끝낸다. 글자 수나 목차 개수를 맞추지 않는다.";
}

export async function composeResearchPrompt(input: {
  title: string;
  category?: string;
  detailArea?: string;
  whyRecommended?: string;
  mode: ProblemMode;
  storyMode?: StoryMode;
}) {
  const [articleDocs, rejectionDocs] = await Promise.all([
    listDocuments<Article>("articles", 300),
    listDocuments<Rejection>("rejections", 300),
  ]);

  const relatedArticles = articleDocs
    .map((article) => ({
      ...article,
      score:
        overlapScore(input.title, article.data.title ?? "") +
        (input.category && article.data.categoryNames?.includes(input.category) ? 0.45 : 0),
    }))
    .filter((article) => article.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const relevantRejections = rejectionDocs
    .filter((item) => item.data.active !== false)
    .filter((item) => !input.category || !item.data.category || item.data.category === input.category)
    .slice(0, 12);

  const blocks = [
    [
      "[역할]",
      "당신은 '인터넷에서 사람들이 반복해서 겪는 작은 문제를 직접 확인하고 해결 과정을 기록하는 개인 블로그'의 문제 조사자이자 미션 설계자다.",
      "이 블로그의 경쟁력은 AI가 경험을 꾸미는 데 있지 않고, 사람이 실제로 수행할 가치가 있는 문제를 골라 실제 Evidence를 남기는 데 있다.",
    ].join("\n"),
    [
      "[절대 원칙]",
      "- 실제로 하지 않은 행동을 1인칭 경험으로 만들지 않는다.",
      "- 아직 검증하지 않은 결과를 성공/실패로 단정하지 않는다.",
      "- SEO를 위해 H2, FAQ, 표, 내부 링크, 이미지 개수, 글자 수를 강제하지 않는다.",
      "- 같은 형식의 글을 반복 생산하려 하지 않는다.",
      "- 짧게 끝나는 문제는 짧게 끝내고, 실패로 끝나도 실제 관찰이면 허용한다.",
    ].join("\n"),
    ["[오늘의 작업 모드]", input.mode, ...modeInstructions(input.mode).map((line) => `- ${line}`)].join("\n"),
    [
      "[현재 후보]",
      `주제: ${input.title}`,
      `카테고리: ${input.category || "미지정"}`,
      `세부 영역: ${input.detailArea || "미지정"}`,
      `추천 배경: ${input.whyRecommended || "별도 설명 없음"}`,
      `연속성 원칙: ${storyInstructions(input.storyMode)}`,
    ].join("\n"),
  ];

  if (relatedArticles.length > 0) {
    blocks.push(
      [
        "[관련 기존 글 — 중복과 연속성 판단용]",
        ...relatedArticles.map(
          (article, index) =>
            `${index + 1}. ${article.data.title ?? "제목 없음"}\n   URL: ${article.data.url ?? ""}\n   카테고리: ${(article.data.categoryNames ?? []).join(", ")}\n   요약: ${(article.data.excerptText ?? "").slice(0, 350)}`,
        ),
      ].join("\n"),
    );
  }

  if (relevantRejections.length > 0) {
    blocks.push(
      [
        "[과거 반려 기록 — 같은 문제를 다시 추천하지 않기 위한 기억]",
        ...relevantRejections.map(
          (item, index) =>
            `${index + 1}. ${item.data.title ?? "제목 없음"} / 범위: ${item.data.scope ?? "CLUSTER"} / 이유: ${item.data.reason ?? "기타"}`,
        ),
      ].join("\n"),
    );
  }

  blocks.push(
    [
      "[판단 순서]",
      "1. 기존 글 또는 반려 기록과 같은 문제/검색 의도인지 판단한다.",
      "2. 일시적 뉴스가 아니라 반복 가능한 Evergreen 문제인지 판단한다.",
      "3. 내가 실제로 재현·비교·확인할 수 있는지 판단한다.",
      "4. 직접 확인했을 때 검색 결과에 없는 Evidence를 만들 수 있는지 판단한다.",
      "5. 하루짜리인지, Living Log인지, 독립적인 Series인지 판단한다.",
    ].join("\n"),
  );

  blocks.push(
    [
      "[출력]",
      "다음 중 하나로 먼저 판정: PROCEED / DUPLICATE / UPDATE_EXISTING / HOLD / REJECT.",
      "PROCEED라면 '오늘 직접 할 미션'만 구체적으로 작성한다.",
      "필요하면 예상 N일차 계획은 행동 계획만 제시하고 미래 결과는 비워둔다.",
      "마지막에는 내가 테스트 후 기록해야 할 Evidence 항목을 최소한으로 적는다.",
    ].join("\n"),
  );

  return blocks.join("\n\n");
}
