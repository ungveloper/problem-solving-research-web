import { normalizeKey, type ProblemRecord } from "@/lib/domain";
import { listDocuments, patchDocument } from "@/lib/firestore";
import { updateProblemNotionPage } from "@/lib/notion";
import type { SyncedWordPressPost } from "@/lib/wordpress";

export async function reconcilePublishedProblems(posts: SyncedWordPressPost[]) {
  const problems = await listDocuments<ProblemRecord>("problems", 500);
  let published = 0;

  for (const item of problems) {
    if (item.data.status === "PUBLISHED" || item.data.status === "REJECTED") continue;

    const expectedUrl = item.data.wordpressUrl?.replace(/\/$/, "");
    const exactByUrl = expectedUrl
      ? posts.find((post) => post.link.replace(/\/$/, "") === expectedUrl)
      : undefined;
    const exactByTitle = item.data.status === "ARTICLE_READY"
      ? posts.find((post) => normalizeKey(post.title) === normalizeKey(item.data.title))
      : undefined;
    const match = exactByUrl ?? exactByTitle;
    if (!match) continue;

    await patchDocument("problems", item.id, {
      status: "PUBLISHED",
      wordpressUrl: match.link,
      linkedArticleId: `wp-${match.id}`,
      publishedDetectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (item.data.notionPageId) {
      await updateProblemNotionPage(item.data.notionPageId, {
        status: "PUBLISHED",
        wordpressUrl: match.link,
      });
    }
    published += 1;
  }

  return { published };
}
