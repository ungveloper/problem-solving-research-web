import { env } from "@/lib/config";
import { pushPendingProblemsToNotion, syncNotionStatuses } from "@/lib/notion";

function authorized(request: Request) {
  if (!env.adminSecret) return false;
  return request.headers.get("authorization") === `Bearer ${env.adminSecret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const pulled = await syncNotionStatuses();
    const pushed = await pushPendingProblemsToNotion();
    return Response.json({ ok: true, pulled, pushed });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "notion sync failed" },
      { status: 500 },
    );
  }
}
