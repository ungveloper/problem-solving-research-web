import { env, NOTION_API_VERSION } from "@/lib/config";
import {
  internalStatusFromNotion,
  notionStatusByInternal,
  type ProblemRecord,
  type ProblemStatus,
  type RejectionScope,
} from "@/lib/domain";
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

function richText(content?: string) {
  return content
    ? [{ type: "text", text: { content: content.slice(0, 2_000) } }]
    : [];
}

function promptBlocks(prompt?: string) {
  if (!prompt) return [];
  const chunks: string[] = [];
  for (let index = 0; index < prompt.length; index += 1_800) {
    chunks.push(prompt.slice(index, index + 1_800));
  }

  return chunks.slice(0, 90).map((chunk) => ({
    object: "block",
    type: "code",
    code: {
      language: "plain text",
      rich_text: richText(chunk),
    },
  }));
}

function baseProperties(id: string, problem: ProblemRecord) {
  return {
    [env.notionTitleProperty]: { title: richText(problem.title) },
    [env.notionStatusProperty]: { status: { name: notionStatusByInternal[problem.status] } },
    "카테고리": problem.category ? { select: { name: problem.category } } : { select: null },
    "세부 영역": problem.detailArea ? { select: { name: problem.detailArea } } : { select: null },
    "유형": { select: { name: problem.mode } },
    "추천점수": { number: problem.score ?? null },
    "Problem ID": { rich_text: richText(id) },
    "Mission ID": { rich_text: [] },
    "연재 유형": problem.storyMode ? { select: { name: problem.storyMode } } : { select: null },
    "현재 일차": { number: problem.currentDay ?? null },
    "관련 기존 글": { rich_text: [] },
    "WordPress URL": { url: problem.wordpressUrl ?? null },
    "반려 이유": problem.rejectionReason ? { select: { name: problem.rejectionReason } } : { select: null },
    "반려 범위": problem.rejectionScope ? { select: { name: problem.rejectionScope } } : { select: null },
    "생성일": { date: { start: problem.createdAt } },
    "Firestore ID": { rich_text: richText(id) },
    "Prompt Version": { rich_text: richText(problem.promptVersion ?? "v1") },
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
      properties: baseProperties(id, problem),
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
  if (fields.status) properties[env.notionStatusProperty] = { status: { name: notionStatusByInternal[fields.status] } };
  if (fields.wordpressUrl !== undefined) properties["WordPress URL"] = { url: fields.wordpressUrl || null };
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
    return { skipped: true, scanned: 0, updated: 0 };
  }

  const pages = await queryNotionPages();
  let updated = 0;

  for (const page of pages) {
    const firestoreId = plainText(page.properties["Firestore ID"]);
    if (!firestoreId) continue;

    const statusLabel = plainText(page.properties[env.notionStatusProperty]);
    const status = internalStatusFromNotion(statusLabel);
    const rejectionReason = plainText(page.properties["반려 이유"]);
    const rejectionScope = plainText(page.properties["반려 범위"]) as RejectionScope | "";
    const wordpressUrl = plainText(page.properties["WordPress URL"]);

    const current = await getDocument<ProblemRecord>("problems", firestoreId);
    if (!current) continue;

    const changes: Record<string, unknown> = { notionPageId: page.id, updatedAt: new Date().toISOString() };
    if (status) changes.status = status;
    if (rejectionReason) changes.rejectionReason = rejectionReason;
    if (rejectionScope) changes.rejectionScope = rejectionScope;
    if (wordpressUrl) changes.wordpressUrl = wordpressUrl;

    await patchDocument("problems", firestoreId, changes);

    if (status === "REJECTED") {
      await upsertDocument("rejections", firestoreId, {
        problemId: firestoreId,
        title: current.data.title,
        category: current.data.category ?? "",
        clusterKey: current.data.clusterKey ?? "",
        reason: rejectionReason || "기타",
        scope: rejectionScope || "CLUSTER",
        active: true,
        rejectedAt: new Date().toISOString(),
      });
    } else {
      const rejection = await getDocument("rejections", firestoreId);
      if (rejection) await patchDocument("rejections", firestoreId, { active: false, updatedAt: new Date().toISOString() });
    }

    updated += 1;
  }

  return { skipped: false, scanned: pages.length, updated };
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
