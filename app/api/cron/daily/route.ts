import { env } from "@/lib/config";
import { runDailySync } from "@/lib/daily-sync";

function authorized(request: Request) {
  if (!env.cronSecret) return false;
  return request.headers.get("authorization") === `Bearer ${env.cronSecret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const previewV4 = url.searchParams.get("preview") === "v3";
    return Response.json({ ok: true, result: await runDailySync("cron", { previewV4 }) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "daily sync failed" },
      { status: 500 },
    );
  }
}
