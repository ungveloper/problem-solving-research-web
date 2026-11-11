import { env } from "@/lib/config";
import type { ProblemMode, StoryMode } from "@/lib/domain";
import { createProblem } from "@/lib/problems";

function authorized(request: Request) {
  if (!env.adminSecret) return false;
  return request.headers.get("authorization") === `Bearer ${env.adminSecret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = (await request.json()) as {
      title?: string;
      category?: string;
      detailArea?: string;
      whyRecommended?: string;
      score?: number;
      mode?: ProblemMode;
      storyMode?: StoryMode;
    };

    if (!body.title?.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    const result = await createProblem({
      ...body,
      title: body.title.trim(),
    });
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "problem creation failed" },
      { status: 500 },
    );
  }
}
