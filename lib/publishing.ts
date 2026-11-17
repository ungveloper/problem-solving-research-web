import { normalizeKey, type ProblemRecord } from "@/lib/domain";
import { listDocuments, patchDocument } from "@/lib/firestore";
import { updateProblemNotionPage } from "@/lib/notion";
import type { SyncedWordPressPost } from "@/lib/wordpress";

type PublicationMatchMethod = "URL" | "TITLE" | "CONTENT";

type PublicationMatch = {
  post: SyncedWordPressPost;
  method: PublicationMatchMethod;
  score: number;
};

const GENERIC_TOKENS = new Set([
  "문제",
  "확인",
  "비교",
  "실제",
  "관련",
  "방법",
  "사용",
  "테스트",
  "결과",
  "직접",
  "새로운",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that",
  "using",
]);

function tokenize(input: string) {
  return [...new Set(
    input
      .normalize("NFKC")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token)),
  )];
}

function coverage(source: string[], target: Set<string>) {
  if (source.length === 0) return 0;
  const matched = source.filter((token) => target.has(token)).length;
  return matched / source.length;
}

function symmetricCoverage(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (coverage(left, rightSet) + coverage(right, leftSet)) / 2;
}

function contentMatchScore(problem: ProblemRecord, post: SyncedWordPressPost) {
  const problemTitleTokens = tokenize(problem.title);
  const postTitleTokens = tokenize(post.title);
  const articleTokens = new Set(tokenize(post.matchText));
  const contextTokens = tokenize([
    problem.category ?? "",
    problem.detailArea ?? "",
    problem.contentConcept ?? "",
    problem.missionSummary ?? "",
    problem.storySeed ?? "",
  ].join(" "));
  const categoryTokens = tokenize(problem.category ?? "");
  const postCategoryTokens = new Set(tokenize(post.categoryNames.join(" ")));

  const titleToTitle = symmetricCoverage(problemTitleTokens, postTitleTokens);
  const titleInArticle = coverage(problemTitleTokens, articleTokens);
  const contextInArticle = coverage(contextTokens, articleTokens);
  const categoryOverlap = coverage(categoryTokens, postCategoryTokens);

  let weighted = 0;
  let weight = 0;

  const add = (value: number, nextWeight: number, enabled = true) => {
    if (!enabled) return;
    weighted += value * nextWeight;
    weight += nextWeight;
  };

  add(titleToTitle, 0.55, problemTitleTokens.length > 0 && postTitleTokens.length > 0);
  add(titleInArticle, 0.25, problemTitleTokens.length > 0);
  add(contextInArticle, 0.15, contextTokens.length > 0);
  add(categoryOverlap, 0.05, categoryTokens.length > 0 && post.categoryNames.length > 0);

  const score = weight > 0 ? weighted / weight : 0;
  return { score, titleToTitle, titleInArticle };
}

function postIsNewEnough(problem: ProblemRecord, post: SyncedWordPressPost) {
  if (!problem.selectedAt) return true;
  const selectedAt = Date.parse(problem.selectedAt);
  const publishedAt = Date.parse(post.publishedAt);
  if (!Number.isFinite(selectedAt) || !Number.isFinite(publishedAt)) return true;

  const toleranceMs = 24 * 60 * 60 * 1000;
  return publishedAt >= selectedAt - toleranceMs;
}

function findPublicationMatch(
  problem: ProblemRecord,
  posts: SyncedWordPressPost[],
): { match?: PublicationMatch; ambiguous: boolean } {
  const expectedUrl = problem.wordpressUrl?.replace(/\/$/, "");
  if (expectedUrl) {
    const post = posts.find((candidate) => candidate.link.replace(/\/$/, "") === expectedUrl);
    if (post) return { match: { post, method: "URL", score: 1 }, ambiguous: false };
  }

  const exactTitle = posts.find(
    (post) =>
      postIsNewEnough(problem, post) &&
      normalizeKey(post.title) === normalizeKey(problem.title),
  );
  if (exactTitle) {
    return { match: { post: exactTitle, method: "TITLE", score: 1 }, ambiguous: false };
  }

  const ranked = posts
    .filter((post) => postIsNewEnough(problem, post))
    .map((post) => ({ post, ...contentMatchScore(problem, post) }))
    .filter(
      (candidate) =>
        candidate.score >= 0.56 &&
        candidate.titleToTitle >= 0.30 &&
        candidate.titleInArticle >= 0.55,
    )
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return { ambiguous: false };

  const best = ranked[0];
  const second = ranked[1];
  if (second && best.score - second.score < 0.08) {
    return { ambiguous: true };
  }

  return {
    match: { post: best.post, method: "CONTENT", score: best.score },
    ambiguous: false,
  };
}

export async function reconcilePublishedProblems(posts: SyncedWordPressPost[]) {
  const problems = await listDocuments<ProblemRecord>("problems", 500);
  const claimedArticleIds = new Set(
    problems
      .map((item) => item.data.linkedArticleId)
      .filter((value): value is string => Boolean(value)),
  );

  let published = 0;
  let matchedByUrl = 0;
  let matchedByTitle = 0;
  let matchedByContent = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const item of problems) {
    if (item.data.status === "PUBLISHED" || item.data.status === "REJECTED") continue;

    const availablePosts = posts.filter((post) => !claimedArticleIds.has(`wp-${post.id}`));
    const result = findPublicationMatch(item.data, availablePosts);

    if (result.ambiguous) {
      ambiguous += 1;
      continue;
    }
    if (!result.match) {
      unmatched += 1;
      continue;
    }

    const { post, method, score } = result.match;
    const now = new Date().toISOString();
    const linkedArticleId = `wp-${post.id}`;

    await patchDocument("problems", item.id, {
      status: "PUBLISHED",
      wordpressUrl: post.link,
      linkedArticleId,
      publicationMatchMethod: method,
      publicationMatchScore: Number(score.toFixed(4)),
      publishedDetectedAt: now,
      updatedAt: now,
    });

    if (item.data.notionPageId) {
      await updateProblemNotionPage(item.data.notionPageId, {
        status: "PUBLISHED",
        wordpressUrl: post.link,
      });
    }

    claimedArticleIds.add(linkedArticleId);
    published += 1;
    if (method === "URL") matchedByUrl += 1;
    if (method === "TITLE") matchedByTitle += 1;
    if (method === "CONTENT") matchedByContent += 1;
  }

  return {
    published,
    matchedByUrl,
    matchedByTitle,
    matchedByContent,
    ambiguous,
    unmatched,
  };
}
