import { createHash } from "node:crypto";

import type {
  DailyPromptRecord,
  DailySelectionDecision,
  DailySelectionPayload,
  ProblemRecord,
  StoryMode,
} from "@/lib/domain";
import { normalizeKey } from "@/lib/domain";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";
import { composeResearchPrompt } from "@/lib/prompt-composer";

function extractJson(raw: string) {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("선택 결과 JSON에서 JSON 객체를 찾을 수 없습니다.");
  return trimmed.slice(first, last + 1);
}

function parseDecision(value: unknown): DailySelectionDecision {
  if (value === "NEW" || value === "CONTINUE" || value === "HOLD" || value === "NO_GO") return value;
  throw new Error("decision은 NEW / CONTINUE / HOLD / NO_GO 중 하나여야 합니다.");
}

function parseStoryMode(value: unknown): StoryMode | undefined {
  if (value === undefined || value === null || value === "" || value === "PENDING_EVIDENCE") return undefined;
  if (value === "ONE_SHOT" || value === "LIVING_LOG" || value === "SERIES") return value;
  throw new Error("storyMode는 ONE_SHOT / LIVING_LOG / SERIES 중 하나여야 합니다. Evidence 전이면 필드를 생략하세요.");
}

export function parseDailySelectionPayload(raw: string): DailySelectionPayload {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("선택 결과 JSON")) throw error;
    throw new Error(`선택 결과 JSON 파싱 실패: ${error instanceof Error ? error.message : "invalid json"}`);
  }

  const text = (key: string) => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const textOrStringArray = (key: string) => {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      return items.length ? items.map((item) => item.trim()).join(" / ") : undefined;
    }
    return undefined;
  };

  return {
    decision: parseDecision(parsed.decision),
    title: text("title"),
    category: text("category"),
    detailArea: text("detailArea"),
    serviceName: text("serviceName"),
    problemFamily: text("problemFamily"),
    concept: text("concept"),
    whyRecommended: text("whyRecommended"),
    missionSummary: text("missionSummary"),
    storySeed: textOrStringArray("storySeed"),
    existingProblemId: text("existingProblemId"),
    storyMode: parseStoryMode(parsed.storyMode),
  };
}

function problemIdFor(dateKey: string, title: string) {
  const digest = createHash("sha256").update(normalizeKey(title)).digest("hex").slice(0, 12);
  return `p-${dateKey}-${digest}`;
}

const DUPLICATE_GENERIC_TOKENS = new Set([
  "문제",
  "오류",
  "이슈",
  "확인",
  "비교",
  "방법",
  "결과",
  "실제",
  "직접",
  "사용",
  "테스트",
  "관련",
  "새로운",
  "차이",
  "경우",
  "파일",
  "사진",
  "데이터",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that",
  "using",
]);

function duplicateTokens(input?: string) {
  if (!input) return [] as string[];
  return [...new Set(
    input
      .normalize("NFKC")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !DUPLICATE_GENERIC_TOKENS.has(token)),
  )];
}

function tokenSimilarity(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const shared = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  const overlap = shared / Math.min(leftSet.size, rightSet.size);
  const jaccard = union > 0 ? shared / union : 0;
  return overlap * 0.65 + jaccard * 0.35;
}

function sharedTokenCount(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((token) => rightSet.has(token)).length;
}

function duplicateProfile(input: {
  title?: string;
  detailArea?: string;
  concept?: string;
  missionSummary?: string;
  storySeed?: string;
}) {
  const title = duplicateTokens(input.title);
  const detail = duplicateTokens(input.detailArea);
  const concept = duplicateTokens(input.concept);
  const mission = duplicateTokens(input.missionSummary);
  const story = duplicateTokens(input.storySeed);
  const all = [...new Set([...title, ...detail, ...concept, ...mission, ...story])];
  return { title, detail, concept, mission, story, all };
}

function duplicateScore(payload: DailySelectionPayload, existing: ProblemRecord) {
  if (payload.title && normalizeKey(payload.title) === normalizeKey(existing.title)) {
    return {
      isDuplicate: true,
      score: 1,
      reason: "EXACT_TITLE",
      sharedTokens: 99,
    };
  }

  const candidate = duplicateProfile({
    title: payload.title,
    detailArea: payload.detailArea,
    concept: payload.concept,
    missionSummary: payload.missionSummary,
    storySeed: payload.storySeed,
  });
  const stored = duplicateProfile({
    title: existing.title,
    detailArea: existing.detailArea,
    concept: existing.contentConcept,
    missionSummary: existing.missionSummary,
    storySeed: existing.storySeed,
  });

  const title = tokenSimilarity(candidate.title, stored.title);
  const detail = tokenSimilarity(candidate.detail, stored.detail);
  const concept = tokenSimilarity(candidate.concept, stored.concept);
  const mission = tokenSimilarity(candidate.mission, stored.mission);
  const story = tokenSimilarity(candidate.story, stored.story);
  const all = tokenSimilarity(candidate.all, stored.all);
  const sharedTokens = sharedTokenCount(candidate.all, stored.all);

  let weighted = 0;
  let weight = 0;
  const add = (value: number, nextWeight: number, enabled: boolean) => {
    if (!enabled) return;
    weighted += value * nextWeight;
    weight += nextWeight;
  };

  add(title, 0.30, candidate.title.length > 0 && stored.title.length > 0);
  add(detail, 0.20, candidate.detail.length > 0 && stored.detail.length > 0);
  add(concept, 0.25, candidate.concept.length > 0 && stored.concept.length > 0);
  add(mission, 0.10, candidate.mission.length > 0 && stored.mission.length > 0);
  add(story, 0.05, candidate.story.length > 0 && stored.story.length > 0);
  add(all, 0.10, candidate.all.length > 0 && stored.all.length > 0);

  const score = weight > 0 ? weighted / weight : 0;
  const strongContext = Math.max(detail, concept);
  const isDuplicate =
    (score >= 0.68 && sharedTokens >= 4) ||
    (title >= 0.55 && strongContext >= 0.50 && sharedTokens >= 3) ||
    (detail >= 0.70 && concept >= 0.65 && sharedTokens >= 3);

  return {
    isDuplicate,
    score,
    reason: isDuplicate ? "SEMANTIC_OVERLAP" : "DISTINCT",
    sharedTokens,
  };
}

async function findPotentialDuplicate(payload: DailySelectionPayload) {
  const problems = await listDocuments<ProblemRecord>("problems", 2_000);
  const ranked = problems
    .map((item) => ({ item, ...duplicateScore(payload, item.data) }))
    .filter((candidate) => candidate.isDuplicate)
    .sort((a, b) => b.score - a.score);

  return ranked[0] ?? null;
}

async function captureNewProblem(dailyId: string, daily: DailyPromptRecord, payload: DailySelectionPayload) {
  if (!payload.title) throw new Error("NEW 결과에는 title이 필요합니다.");

  const duplicate = await findPotentialDuplicate(payload);
  if (duplicate) {
    const now = new Date().toISOString();
    await patchDocument("dailyPrompts", dailyId, {
      status: "HOLD",
      selectionOriginalDecision: "NEW",
      selectionDecision: "HOLD",
      linkedProblemId: duplicate.item.id,
      duplicateOfProblemId: duplicate.item.id,
      duplicateScore: Number(duplicate.score.toFixed(4)),
      duplicateDetectedAt: now,
      selectionCapturedAt: now,
      updatedAt: now,
    });

    return {
      action: "DUPLICATE_BLOCKED" as const,
      problemId: duplicate.item.id,
      duplicateTitle: duplicate.item.data.title,
      duplicateScore: Number(duplicate.score.toFixed(4)),
    };
  }

  const now = new Date().toISOString();
  const storyMode = payload.storyMode;
  const prompt = await composeResearchPrompt({
    title: payload.title,
    category: payload.category,
    detailArea: payload.detailArea,
    whyRecommended: payload.whyRecommended,
    mode: "NEW",
    storyMode,
  });
  const id = problemIdFor(daily.dateKey, payload.title);
  const problem: ProblemRecord = {
    title: payload.title,
    category: payload.category,
    detailArea: payload.detailArea,
    serviceName: payload.serviceName,
    problemFamily: payload.problemFamily,
    whyRecommended: payload.whyRecommended,
    status: "IN_PROGRESS",
    mode: "NEW",
    storyMode,
    currentDay: 1,
    clusterKey: normalizeKey(`${payload.category ?? ""} ${payload.detailArea ?? ""} ${payload.title}`),
    contentConcept: payload.concept,
    missionSummary: payload.missionSummary,
    storySeed: payload.storySeed,
    sourceDailyPromptId: dailyId,
    sourceDailyPromptDateKey: daily.dateKey,
    selectedAt: now,
    prompt,
    promptVersion: "research-v1",
    createdAt: now,
    updatedAt: now,
  };

  await upsertDocument("problems", id, problem);
  await patchDocument("dailyPrompts", dailyId, {
    status: "ARTICLE_READY",
    selectionDecision: "NEW",
    linkedProblemId: id,
    selectionCapturedAt: now,
    updatedAt: now,
  });
  return { action: "CREATED" as const, problemId: id, problem };
}

async function captureContinuation(dailyId: string, daily: DailyPromptRecord, payload: DailySelectionPayload) {
  if (!payload.existingProblemId) throw new Error("CONTINUE 결과에는 existingProblemId가 필요합니다.");
  const existing = await getDocument<ProblemRecord>("problems", payload.existingProblemId);
  if (!existing) throw new Error(`이어갈 Problem을 찾을 수 없습니다: ${payload.existingProblemId}`);
  if (existing.data.status === "REJECTED") throw new Error("반려된 Problem은 자동으로 다시 진행할 수 없습니다.");

  const now = new Date().toISOString();
  await patchDocument("problems", existing.id, {
    status: "IN_PROGRESS",
    ...(payload.serviceName ? { serviceName: payload.serviceName } : {}),
    ...(payload.problemFamily ? { problemFamily: payload.problemFamily } : {}),
    ...(payload.concept ? { contentConcept: payload.concept } : {}),
    ...(payload.missionSummary ? { missionSummary: payload.missionSummary } : {}),
    ...(payload.storySeed ? { storySeed: payload.storySeed } : {}),
    ...(payload.whyRecommended ? { whyRecommended: payload.whyRecommended } : {}),
    sourceDailyPromptId: dailyId,
    sourceDailyPromptDateKey: daily.dateKey,
    selectedAt: now,
    updatedAt: now,
  });
  await patchDocument("dailyPrompts", dailyId, {
    status: "ARTICLE_READY",
    selectionDecision: "CONTINUE",
    linkedProblemId: existing.id,
    selectionCapturedAt: now,
    updatedAt: now,
  });

  return { action: "CONTINUED" as const, problemId: existing.id, problem: { ...existing.data, status: "IN_PROGRESS" as const } };
}

export async function captureDailySelectionResult(dailyId: string, raw: string) {
  const daily = await getDocument<DailyPromptRecord>("dailyPrompts", dailyId);
  if (!daily) throw new Error(`Daily Prompt를 찾을 수 없습니다: ${dailyId}`);

  if (daily.data.selectionCapturedAt) {
    return {
      action: "ALREADY_CAPTURED" as const,
      decision: daily.data.selectionDecision,
      problemId: daily.data.linkedProblemId ?? "",
    };
  }

  const payload = parseDailySelectionPayload(raw);
  const now = new Date().toISOString();
  await patchDocument("dailyPrompts", dailyId, {
    selectionJson: extractJson(raw),
    selectionDecision: payload.decision,
    updatedAt: now,
  });

  if (payload.decision === "NEW") {
    return { decision: payload.decision, ...(await captureNewProblem(dailyId, daily.data, payload)) };
  }
  if (payload.decision === "CONTINUE") {
    return { decision: payload.decision, ...(await captureContinuation(dailyId, daily.data, payload)) };
  }

  await patchDocument("dailyPrompts", dailyId, {
    status: "HOLD",
    selectionDecision: payload.decision,
    selectionCapturedAt: now,
    updatedAt: now,
  });
  return { action: "RECORDED_ONLY" as const, decision: payload.decision, problemId: "" };
}
