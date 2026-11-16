import { env } from "@/lib/config";
import { ensureDailyPrompt } from "@/lib/daily-prompt";
import { upsertDocument } from "@/lib/firestore";
import {
  pushPendingDailyPromptsToNotion,
  pushPendingProblemsToNotion,
  syncNotionStatuses,
} from "@/lib/notion";
import { reconcilePublishedProblems } from "@/lib/publishing";
import { ensureSiteProfile } from "@/lib/site-profile";
import { syncWordPress } from "@/lib/wordpress";

function koreaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function runDailySync(
  trigger: "cron" | "manual" | "webhook" = "manual",
  options: { previewV5?: boolean } = {},
) {
  const startedAt = new Date().toISOString();

  const profile = await ensureSiteProfile();
  const notion = await syncNotionStatuses();

  const wordpress = await syncWordPress();
  const publishing = wordpress.skipped
    ? { skipped: true, published: 0 }
    : { skipped: false, ...(await reconcilePublishedProblems(wordpress.posts)) };

  const dailyPrompt = await ensureDailyPrompt(undefined, { previewV5: options.previewV5 });
  const problemPush = await pushPendingProblemsToNotion();
  const dailyPromptPush = await pushPendingDailyPromptsToNotion();

  const finishedAt = new Date().toISOString();
  const result = {
    trigger,
    previewV5: Boolean(options.previewV5),
    siteId: env.siteId,
    phase: profile.data.phase,
    startedAt,
    finishedAt,
    wordpress: {
      configured: Boolean(env.wordpressBaseUrl),
      skipped: wordpress.skipped,
      categories: wordpress.categories,
      articles: wordpress.articles,
    },
    publishing,
    notion,
    dailyPrompt: {
      id: dailyPrompt.id,
      created: dailyPrompt.created,
      mode: dailyPrompt.data.mode,
      notionPageId: dailyPrompt.data.notionPageId ?? "",
    },
    notionPush: {
      problems: problemPush,
      dailyPrompts: dailyPromptPush,
    },
  };

  await upsertDocument(
    "dailyRuns",
    `${koreaDateKey()}-${trigger}${options.previewV5 ? "-v5-preview" : ""}`,
    result,
  );
  return result;
}
