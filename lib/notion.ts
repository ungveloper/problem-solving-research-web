import { env, NOTION_API_VERSION } from "@/lib/config";
import {
  internalStatusFromNotion,
  notionStatusByInternal,
  type DailyPromptRecord,
  type ProblemRecord,
  type ProblemStatus,
  type RejectionScope,
} from "@/lib/domain";
import { captureDailySelectionResult } from "@/lib/daily-result";
import { getDocument, listDocuments, patchDocument, upsertDocument } from "@/lib/firestore";

const NOTION_API = "https://api.notion.com/v1";

function headers() {
  if (!env.notionApiKey) throw new Error("NOTION_API_KEY가 설정되지 않았습니다.");
  return {
    authorization: `Bearer ${env.notionApiKey}`,
    "content-type": "application/json",
    "Notion-Version": NOTION_API_VERSION,
  };
}

async function notionFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Notion API 호출 실패: ${response.status} ${await response.text()}`);
  }
  return response;
}

const MINIMAL_PROPERTIES: Record<string, unknown> = {
  "유형": { select: {} },
  "생성일": { date: {} },
  "Firestore ID": { rich_text: {} },
  "선택 결과 JSON": { rich_text: {} },
  "결과 반영": { checkbox: {} },
  "반려 이유": { select: {} },
  "반려 범위": { select: {} },
};

const LEGACY_PROPERTIES = [
  "카테고리",
  "세부 영역",
  "추천점수",
  "Problem ID",
  "Mission ID",
  "연재 유형",
  "현재 일차",
  "관련 기존 글",
  "WordPress URL",
  "Prompt Version",
  "진행하기",
  "보류",
  "반려",
  "작성 완료",
] as const;

async function ensureDailyResultCaptureSchema() {
  if (!env.notionDataSourceId) return { added: [] as string[], removed: [] as string[] };
  const response = await notionFetch(`/data_sources/${env.notionDataSourceId}`);
  const dataSource = (await response.json()) as { properties?: Record<string, unknown> };
  const properties = dataSource.properties ?? {};
  const updates: Record<string, unknown> = {};
  const added: string[] = [];
  const removed: string[] = [];

  for (const [name, schema] of Object.entries(MINIMAL_PROPERTIES)) {
    if (!(name in properties)) {
      updates[name] = schema;
      added.push(name);
    }
  }

  for (const name of LEGACY_PROPERTIES) {
    if (name in properties) {
      updates[name] = null;
      removed.push(name);
    }
  }

  if (Object.keys(updates).length > 0) {
    await notionFetch(`/data_sources/${env.notionDataSourceId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: updates }),
    });
  }
  return { added, removed };
}

function richText(content?: string) {
  return content
    ? [{ type: "text", text: { content: content.slice(0, 2_000) } }]
    : [];
}

function promptRichText(prompt?: string) {
  if (!prompt) return [];
  const segments = [];
  for (let index = 0; index < prompt.length; index += 1_800) {
    segments.push({ type: "text", text: { content: prompt.slice(index, index + 1_800) } });
  }
  return segments.slice(0, 100);
}

function promptBlocks(prompt?: string) {
  if (!prompt) return [];
  return [
    {
      object: "block",
      type: "code",
      code: {
        language: "plain text",
        rich_text: promptRichText(prompt),
      },
    },
  ];
}

function baseProblemProperties(id: string, problem: ProblemRecord) {
  return {
    [env.notionTitleProperty]: { title: richText(problem.title) },
    [env.notionStatusProperty]: { status: { name: notionStatusByInternal[problem.status] } },
    "유형": { select: { name: problem.mode } },
    "생성일": { date: { start: problem.createdAt } },
    "Firestore ID": { rich_text: richText(id) },
    "반려 이유": problem.rejectionReason ? { select: { name: problem.rejectionReason } } : { select: null },
    "반려 범위": problem.rejectionScope ? { select: { name: problem.rejectionScope } } : { select: null },
  };
}

function baseDailyPromptProperties(id: string, daily: DailyPromptRecord) {
  return {
    [env.notionTitleProperty]: { title: richText(daily.title) },
    [env.notionStatusProperty]: { status: { name: notionStatusByInternal[daily.status] } },
    "유형": { select: { name: "DAILY_RESEARCH" } },
    "생성일": { date: { start: daily.createdAt } },
    "Firestore ID": { rich_text: richText(id) },
    "선택 결과 JSON": { rich_text: richText(daily.selectionJson ?? "") },
    "결과 반영": { checkbox: false },
  };
}

export async function createProblemNotionPage(id: string, problem: ProblemRecord) {
  if (!env.notionDataSourceId) throw new Error("NOTION_DATA_SOURCE_ID가 설정되지 않았습니다.");

  const children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: richText(
          problem.whyRecommended
            ? `추천 이유: ${problem.whyRecommended}`
            : "Firestore가 원본 상태를 관리하고, 이 페이지는 운영 명령과 프롬프트 확인에 사용합니다.",
        ),
      },
    },
    ...(problem.contentConcept
      ? [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: richText(`선택 콘텐츠 콘셉트: ${problem.contentConcept}`) },
          },
        ]
      : []),
    ...(problem.missionSummary
      ? [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: richText(`현재 Mission: ${problem.missionSummary}`) },
          },
        ]
      : []),
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText("ChatGPT Plus용 프롬프트") },
    },
    ...promptBlocks(problem.prompt),
  ];

  const response = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: env.notionDataSourceId },
      properties: baseProblemProperties(id, problem),
      children,
    }),
  });

  return (await response.json()) as { id: string; url?: string };
}

export async function createDailyPromptNotionPage(id: string, daily: DailyPromptRecord) {
  if (!env.notionDataSourceId) throw new Error("NOTION_DATA_SOURCE_ID가 설정되지 않았습니다.");
  await ensureDailyResultCaptureSchema();

  const children = [
    {
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "🧭" },
        rich_text: richText(
          daily.mode === "CONTINUATION_FIRST"
            ? "진행 중인 문제를 먼저 이어갈지 판단하는 일일 세션입니다. 아래 프롬프트를 ChatGPT Plus에 그대로 붙여넣으세요."
            : "오늘 직접 확인할 문제를 찾는 일일 조사 세션입니다. 아래 프롬프트를 ChatGPT Plus에 그대로 붙여넣으세요.",
        ),
      },
    },
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText("ChatGPT Plus에 그대로 붙여넣기") },
    },
    ...promptBlocks(daily.prompt),
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: richText("선택 결과를 Problem 기억으로 반영") },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: richText(
          "ChatGPT 답변 맨 마지막의 PROBLEM_MEMORY_JSON만 '선택 결과 JSON'에 붙여넣고 '결과 반영'을 체크하세요. 다음 동기화가 Firestore Problem으로 저장하거나 기존 Problem에 연결합니다.",
        ),
      },
    },
  ];

  const response = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: env.notionDataSourceId },
      properties: baseDailyPromptProperties(id, daily),
      children,
    }),
  });

  return (await response.json()) as { id: string; url?: string };
}

export async function updateProblemNotionPage(
  pageId: string,
  fields: { status?: ProblemStatus; wordpressUrl?: string; rejectionReason?: string; rejectionScope?: RejectionScope },
) {
  const properties: Record<string, unknown> = {};
  void fields.wordpressUrl; // WordPress URL은 현재 Notion 최소 스키마에 노출하지 않고 Firestore에서만 유지합니다.
  if (fields.status) properties[env.notionStatusProperty] = { status: { name: notionStatusByInternal[fields.status] } };
  if (fields.rejectionReason !== undefined) {
    properties["반려 이유"] = fields.rejectionReason ? { select: { name: fields.rejectionReason } } : { select: null };
  }
  if (fields.rejectionScope !== undefined) {
    properties["반려 범위"] = fields.rejectionScope ? { select: { name: fields.rejectionScope } } : { select: null };
  }

  if (Object.keys(properties).length === 0) return;
  await notionFetch(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
}

type NotionProperty = Record<string, unknown>;
type NotionPage = { id: string; properties: Record<string, NotionProperty> };

function plainText(property?: NotionProperty) {
  if (!property) return "";
  const rich = (property.rich_text ?? property.title) as Array<{ plain_text?: string }> | undefined;
  if (rich) return rich.map((item) => item.plain_text ?? "").join("");
  const select = property.select as { name?: string } | null | undefined;
  if (select?.name) return select.name;
  const status = property.status as { name?: string } | null | undefined;
  if (status?.name) return status.name;
  const url = property.url;
  if (typeof url === "string") return url;
  return "";
}

function checkboxValue(property?: NotionProperty) {
  if (!property) return false;
  return property.checkbox === true;
}

async function queryNotionPages() {
  if (!env.notionDataSourceId) return [] as NotionPage[];
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await notionFetch(`/data_sources/${env.notionDataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const payload = (await response.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    pages.push(...(payload.results ?? []));
    if (!payload.has_more || !payload.next_cursor) break;
    cursor = payload.next_cursor;
  }

  return pages;
}

export async function syncNotionStatuses() {
  if (!env.notionApiKey || !env.notionDataSourceId) {
    return { skipped: true, scanned: 0, problemsUpdated: 0, dailyPromptsUpdated: 0, resultsCaptured: 0, schemaAdded: [] as string[], schemaRemoved: [] as string[] };
  }

  const schema = await ensureDailyResultCaptureSchema();
  const pages = await queryNotionPages();
  let problemsUpdated = 0;
  let dailyPromptsUpdated = 0;
  let resultsCaptured = 0;

  for (const page of pages) {
    const firestoreId = plainText(page.properties["Firestore ID"]);
    if (!firestoreId) continue;

    const statusLabel = plainText(page.properties[env.notionStatusProperty]);
    const status = internalStatusFromNotion(statusLabel);

    const currentProblem = await getDocument<ProblemRecord>("problems", firestoreId);
    if (currentProblem) {
      const rejectionReason = plainText(page.properties["반려 이유"]);
      const rejectionScope = plainText(page.properties["반려 범위"]) as RejectionScope | "";

      const changes: Record<string, unknown> = { notionPageId: page.id, updatedAt: new Date().toISOString() };
      if (status) changes.status = status;
      if (rejectionReason) changes.rejectionReason = rejectionReason;
      if (rejectionScope) changes.rejectionScope = rejectionScope;

      await patchDocument("problems", firestoreId, changes);

      if (status === "REJECTED") {
        await upsertDocument("rejections", firestoreId, {
          problemId: firestoreId,
          title: currentProblem.data.title,
          category: currentProblem.data.category ?? "",
          clusterKey: currentProblem.data.clusterKey ?? "",
          reason: rejectionReason || "기타",
          scope: rejectionScope || "CLUSTER",
          active: true,
          rejectedAt: new Date().toISOString(),
        });
      } else {
        const rejection = await getDocument("rejections", firestoreId);
        if (rejection) await patchDocument("rejections", firestoreId, { active: false, updatedAt: new Date().toISOString() });
      }

      problemsUpdated += 1;
      continue;
    }

    const currentDaily = await getDocument<DailyPromptRecord>("dailyPrompts", firestoreId);
    if (currentDaily) {
      const selectionJson = plainText(page.properties["선택 결과 JSON"]);
      const importRequested = checkboxValue(page.properties["결과 반영"]);
      await patchDocument("dailyPrompts", firestoreId, {
        notionPageId: page.id,
        ...(status ? { status } : {}),
        ...(selectionJson ? { selectionJson } : {}),
        updatedAt: new Date().toISOString(),
      });

      if (importRequested) {
        if (!selectionJson) throw new Error(`${firestoreId}: 결과 반영이 체크됐지만 선택 결과 JSON이 비어 있습니다.`);
        const captured = await captureDailySelectionResult(firestoreId, selectionJson);
        const problemId = captured.problemId ?? "";
        await notionFetch(`/pages/${page.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            properties: {
              "결과 반영": { checkbox: false },
            },
          }),
        });
        resultsCaptured += 1;
      }

      dailyPromptsUpdated += 1;
    }
  }

  return {
    skipped: false,
    scanned: pages.length,
    problemsUpdated,
    dailyPromptsUpdated,
    resultsCaptured,
    schemaAdded: schema.added,
    schemaRemoved: schema.removed,
  };
}

export async function pushPendingProblemsToNotion() {
  if (!env.notionApiKey || !env.notionDataSourceId) return { skipped: true, created: 0 };
  const problems = await listDocuments<ProblemRecord>("problems", 300);
  let created = 0;

  for (const problem of problems) {
    if (problem.data.notionPageId) continue;
    const page = await createProblemNotionPage(problem.id, problem.data);
    await patchDocument("problems", problem.id, {
      notionPageId: page.id,
      notionUrl: page.url ?? "",
      updatedAt: new Date().toISOString(),
    });
    created += 1;
  }

  return { skipped: false, created };
}

export async function pushPendingDailyPromptsToNotion() {
  if (!env.notionApiKey || !env.notionDataSourceId) return { skipped: true, created: 0 };
  await ensureDailyResultCaptureSchema();
  const prompts = await listDocuments<DailyPromptRecord>("dailyPrompts", 120);
  let created = 0;

  for (const prompt of prompts) {
    if (prompt.data.notionPageId) continue;
    const page = await createDailyPromptNotionPage(prompt.id, prompt.data);
    await patchDocument("dailyPrompts", prompt.id, {
      notionPageId: page.id,
      notionUrl: page.url ?? "",
      updatedAt: new Date().toISOString(),
    });
    created += 1;
  }

  return { skipped: false, created };
}
