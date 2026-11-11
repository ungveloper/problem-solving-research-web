import { env } from "@/lib/config";
import { upsertDocument } from "@/lib/firestore";
import { pushPendingProblemsToNotion, syncNotionStatuses } from "@/lib/notion";
import { reconcilePublishedProblems } from "@/lib/publishing";
import { syncWordPress } from "@/lib/wordpress";

function koreaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function runDailySync(trigger: "cron" | "manual" | "webhook" = "manual") {
  const startedAt = new Date().toISOString();
  const wordpress = await syncWordPress();
  const publishing = await reconcilePublishedProblems(wordpress.posts);
  const notion = await syncNotionStatuses();
  const notionPush = await pushPendingProblemsToNotion();
  const finishedAt = new Date().toISOString();

  const result = {
    trigger,
    siteId: env.siteId,
    startedAt,
    finishedAt,
    wordpress: { skipped: wordpress.skipped, categories: wordpress.categories, articles: wordpress.articles },
    publishing,
    notion,
    notionPush,
  };

  await upsertDocument("dailyRuns", `${koreaDateKey()}-${trigger}`, result);
  return result;
}
