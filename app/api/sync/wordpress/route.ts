import { env } from "@/lib/config";
import { reconcilePublishedProblems } from "@/lib/publishing";
import { syncWordPress } from "@/lib/wordpress";

function authorized(request: Request) {
  if (!env.adminSecret) return false;
  return request.headers.get("authorization") === `Bearer ${env.adminSecret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const wordpress = await syncWordPress();
    const publishing = await reconcilePublishedProblems(wordpress.posts);
    return Response.json({ ok: true, wordpress, publishing });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "wordpress sync failed" },
      { status: 500 },
    );
  }
}
