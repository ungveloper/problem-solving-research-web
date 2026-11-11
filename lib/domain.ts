export const problemStatuses = [
  "RECOMMENDED",
  "IN_PROGRESS",
  "TESTING",
  "READY_TO_WRITE",
  "ARTICLE_READY",
  "PUBLISHED",
  "HOLD",
  "REJECTED",
] as const;

export type ProblemStatus = (typeof problemStatuses)[number];

export type ProblemMode = "NEW" | "CONTINUE" | "UPDATE" | "EXPAND";
export type StoryMode = "ONE_SHOT" | "LIVING_LOG" | "SERIES";
export type RejectionScope = "EXACT" | "CLUSTER" | "SCOPE";

export type ProblemRecord = {
  title: string;
  category?: string;
  detailArea?: string;
  whyRecommended?: string;
  status: ProblemStatus;
  mode: ProblemMode;
  storyMode?: StoryMode;
  score?: number;
  currentDay?: number;
  clusterKey?: string;
  prompt?: string;
  promptVersion?: string;
  notionPageId?: string;
  wordpressUrl?: string;
  linkedArticleId?: string;
  rejectionReason?: string;
  rejectionScope?: RejectionScope;
  createdAt: string;
  updatedAt: string;
};

export const notionStatusByInternal: Record<ProblemStatus, string> = {
  RECOMMENDED: "추천됨",
  IN_PROGRESS: "진행",
  TESTING: "테스트 중",
  READY_TO_WRITE: "글쓰기 준비",
  ARTICLE_READY: "작성 완료",
  PUBLISHED: "발행 완료",
  HOLD: "보류",
  REJECTED: "반려",
};

export function internalStatusFromNotion(value: string): ProblemStatus | null {
  const entry = Object.entries(notionStatusByInternal).find(([, label]) => label === value);
  return (entry?.[0] as ProblemStatus | undefined) ?? null;
}

export function normalizeKey(input: string) {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 160);
}
