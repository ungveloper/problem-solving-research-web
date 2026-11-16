import { env } from "@/lib/config";
import { ensureDailyPrompt } from "@/lib/daily-prompt";
import { pushPendingDailyPromptsToNotion } from "@/lib/notion";

function authorized(request: Request) {
  if (!env.adminSecret) return false;
  return request.headers.get("authorization") === `Bearer ${env.adminSecret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const daily = await ensureDailyPrompt();
    const notion = await pushPendingDailyPromptsToNotion();
    return Response.json({ ok: true, daily, notion });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "daily prompt generation failed" },
      { status: 500 },
    );
  }
}
