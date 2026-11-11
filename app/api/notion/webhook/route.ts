import { env } from "@/lib/config";
import { syncNotionStatuses } from "@/lib/notion";

export async function POST(request: Request) {
  if (!env.notionWebhookSecret) {
    return Response.json({ error: "NOTION_WEBHOOK_SECRET is not configured" }, { status: 503 });
  }

  const secret = request.headers.get("x-webhook-secret");
  if (secret !== env.notionWebhookSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // Payload shape can change depending on the Notion automation configuration.
    // Firestore is reconciled from the authoritative Notion data source instead.
    await request.text();
    const result = await syncNotionStatuses();
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "notion sync failed" },
      { status: 500 },
    );
  }
}
