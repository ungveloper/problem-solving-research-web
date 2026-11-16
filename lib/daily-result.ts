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

  return {
    decision: parseDecision(parsed.decision),
    title: text("title"),
    category: text("category"),
    detailArea: text("detailArea"),
    concept: text("concept"),
    whyRecommended: text("whyRecommended"),
    missionSummary: text("missionSummary"),
    existingProblemId: text("existingProblemId"),
    storyMode: parseStoryMode(parsed.storyMode),
  };
}

function problemIdFor(dateKey: string, title: string) {
  const digest = createHash("sha256").update(normalizeKey(title)).digest("hex").slice(0, 12);
  return `p-${dateKey}-${digest}`;
}

async function findExactExistingProblem(title: string) {
  const target = normalizeKey(title);
  const problems = await listDocuments<ProblemRecord>("problems", 500);
  return problems.find((item) => normalizeKey(item.data.title) === target) ?? null;
}

async function captureNewProblem(dailyId: string, daily: DailyPromptRecord, payload: DailySelectionPayload) {
  if (!payload.title) throw new Error("NEW 결과에는 title이 필요합니다.");

  const existing = await findExactExistingProblem(payload.title);
  if (existing) {
    throw new Error(
      `동일한 Problem이 이미 존재합니다 (${existing.id}: ${existing.data.title}). NEW로 중복 생성하지 말고 CONTINUE 또는 HOLD로 판단하세요.`,
    );
  }

  const now = new Date().toISOString();
  const storyMode = payload.storyMode ?? "ONE_SHOT";
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
    whyRecommended: payload.whyRecommended,
    status: "IN_PROGRESS",
    mode: "NEW",
    storyMode,
    currentDay: 1,
    clusterKey: normalizeKey(`${payload.category ?? ""} ${payload.detailArea ?? ""} ${payload.title}`),
    contentConcept: payload.concept,
    missionSummary: payload.missionSummary,
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
    ...(payload.concept ? { contentConcept: payload.concept } : {}),
    ...(payload.missionSummary ? { missionSummary: payload.missionSummary } : {}),
    ...(payload.whyRecommended ? { whyRecommended: payload.whyRecommended } : {}),
    sourceDailyPromptId: dailyId,
    sourceDailyPromptDateKey: daily.dateKey,
    selectedAt: now,
    updatedAt: now,
  });
  await patchDocument("dailyPrompts", dailyId, {
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
    selectionDecision: payload.decision,
    selectionCapturedAt: now,
    updatedAt: now,
  });
  return { action: "RECORDED_ONLY" as const, decision: payload.decision, problemId: "" };
}
