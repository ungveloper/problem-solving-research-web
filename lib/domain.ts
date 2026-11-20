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
export type DailyPromptMode = "DISCOVERY" | "CONTINUATION_FIRST";
export type DailySelectionDecision = "NEW" | "CONTINUE" | "HOLD" | "NO_GO";

export type DailySelectionPayload = {
  decision: DailySelectionDecision;
  title?: string;
  category?: string;
  detailArea?: string;
  serviceName?: string;
  problemFamily?: string;
  concept?: string;
  whyRecommended?: string;
  missionSummary?: string;
  storySeed?: string;
  existingProblemId?: string;
  storyMode?: StoryMode;
};

export type ProblemRecord = {
  title: string;
  category?: string;
  detailArea?: string;
  serviceName?: string;
  problemFamily?: string;
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
  notionUrl?: string;
  wordpressUrl?: string;
  linkedArticleId?: string;
  publicationMatchMethod?: "URL" | "TITLE" | "CONTENT";
  publicationMatchScore?: number;
  publishedDetectedAt?: string;
  rejectionReason?: string;
  rejectionScope?: RejectionScope;
  contentConcept?: string;
  missionSummary?: string;
  storySeed?: string;
  sourceDailyPromptId?: string;
  sourceDailyPromptDateKey?: string;
  selectedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type DailyPromptRecord = {
  title: string;
  dateKey: string;
  status: ProblemStatus;
  mode: DailyPromptMode;
  prompt: string;
  promptVersion: string;
  notionPageId?: string;
  notionUrl?: string;
  selectionJson?: string;
  selectionDecision?: DailySelectionDecision;
  selectionOriginalDecision?: DailySelectionDecision;
  linkedProblemId?: string;
  duplicateOfProblemId?: string;
  duplicateScore?: number;
  duplicateDetectedAt?: string;
  selectionCapturedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SiteProfileRecord = {
  siteId: string;
  phase: "PROMPT_VALIDATION" | "WORDPRESS_CONNECTED";
  activeScopes: string[];
  principles: string[];
  wordpressDeferred: boolean;
  dailyPromptTime: string;
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
