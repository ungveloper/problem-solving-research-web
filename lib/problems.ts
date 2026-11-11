import { randomUUID } from "node:crypto";
import { env } from "@/lib/config";
import { normalizeKey, type ProblemMode, type ProblemRecord, type StoryMode } from "@/lib/domain";
import { patchDocument, upsertDocument } from "@/lib/firestore";
import { createProblemNotionPage } from "@/lib/notion";
import { composeResearchPrompt } from "@/lib/prompt-composer";

export async function createProblem(input: {
  title: string;
  category?: string;
  detailArea?: string;
  whyRecommended?: string;
  score?: number;
  mode?: ProblemMode;
  storyMode?: StoryMode;
}) {
  const now = new Date().toISOString();
  const id = `p-${now.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const mode = input.mode ?? "NEW";
  const prompt = await composeResearchPrompt({ ...input, mode });

  const problem: ProblemRecord = {
    title: input.title,
    category: input.category,
    detailArea: input.detailArea,
    whyRecommended: input.whyRecommended,
    status: "RECOMMENDED",
    mode,
    storyMode: input.storyMode ?? "ONE_SHOT",
    score: input.score,
    currentDay: 1,
    clusterKey: normalizeKey(`${input.category ?? ""} ${input.detailArea ?? ""} ${input.title}`),
    prompt,
    promptVersion: "research-v1",
    createdAt: now,
    updatedAt: now,
  };

  await upsertDocument("problems", id, problem);

  if (env.notionApiKey && env.notionDataSourceId) {
    const page = await createProblemNotionPage(id, problem);
    await patchDocument("problems", id, {
      notionPageId: page.id,
      notionUrl: page.url ?? "",
      updatedAt: new Date().toISOString(),
    });
  }

  return { id, problem };
}
