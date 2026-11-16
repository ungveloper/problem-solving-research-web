import { Suspense } from "react";

import { getConnectionState } from "@/lib/config";
import type { DailyPromptRecord, ProblemRecord } from "@/lib/domain";
import { listDocuments } from "@/lib/firestore";

type Article = {
  title?: string;
  url?: string;
  categoryNames?: string[];
  modifiedAt?: string;
};

type DailyRun = {
  startedAt?: string;
  finishedAt?: string;
  trigger?: string;
  wordpress?: { configured?: boolean; skipped?: boolean; articles?: number };
  notion?: { problemsUpdated?: number; dailyPromptsUpdated?: number };
  dailyPrompt?: { id?: string; created?: boolean; mode?: string };
};

async function dashboardData() {
  const connections = getConnectionState();
  if (!connections.firebase.configured) {
    return { connections, articles: [], problems: [], dailyPrompts: [], runs: [] };
  }

  const [articles, problems, dailyPrompts, runs] = await Promise.all([
    listDocuments<Article>("articles", 200),
    listDocuments<ProblemRecord>("problems", 200),
    listDocuments<DailyPromptRecord>("dailyPrompts", 60),
    listDocuments<DailyRun>("dailyRuns", 30),
  ]);

  return { connections, articles, problems, dailyPrompts, runs };
}

function ConnectionBadge({
  name,
  configured,
  optional = false,
}: {
  name: string;
  configured: boolean;
  optional?: boolean;
}) {
  const label = configured ? "연결됨" : optional ? "나중 연결" : "설정 필요";
  const tone = configured
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
    : optional
      ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";

  return (
    <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="text-sm font-medium">{name}</span>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>
    </div>
  );
}

async function DashboardContent() {
  const { connections, articles, problems, dailyPrompts, runs } = await dashboardData();
  const rejected = problems.filter((item) => item.data.status === "REJECTED").length;
  const active = problems.filter((item) => ["IN_PROGRESS", "TESTING", "READY_TO_WRITE"].includes(item.data.status)).length;
  const latestArticles = [...articles]
    .sort((a, b) => String(b.data.modifiedAt ?? "").localeCompare(String(a.data.modifiedAt ?? "")))
    .slice(0, 8);
  const latestPrompt = [...dailyPrompts]
    .sort((a, b) => String(b.data.dateKey ?? "").localeCompare(String(a.data.dateKey ?? "")))[0];
  const latestRun = [...runs]
    .sort((a, b) => String(b.data.finishedAt ?? "").localeCompare(String(a.data.finishedAt ?? "")))[0];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-5 py-10 sm:px-8">
      <section className="space-y-3">
        <p className="text-sm font-semibold text-zinc-500">Problem Solving Research</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">문제 해결소</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              현재는 Prompt Validation 단계입니다. Notion은 명령을 내리는 화면, Firestore는 기억하는 원본 DB이며,
              WordPress는 프롬프트 품질 검증이 끝난 뒤 연결합니다.
            </p>
          </div>
          <a
            href="/api/health"
            className="w-fit rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            연결 상태 JSON
          </a>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <ConnectionBadge name="Firestore" configured={connections.firebase.configured} />
        <ConnectionBadge name="Notion" configured={connections.notion.configured} />
        <ConnectionBadge name="WordPress" configured={connections.wordpress.configured} optional />
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ["일일 프롬프트", dailyPrompts.length],
          ["Problem", problems.length],
          ["진행 중", active],
          ["반려 기억", rejected],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm text-zinc-500">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </section>

      {!connections.firebase.configured || !connections.notion.configured ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="text-lg font-semibold">Firestore와 Notion을 먼저 연결하세요</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
            WordPress는 비워둬도 됩니다. 현재 단계의 필수 연결은 Firestore와 Notion뿐입니다.
          </p>
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[1.15fr_.85fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Latest Daily Prompt</p>
                <h2 className="mt-1 font-semibold">{latestPrompt?.data.title ?? "아직 생성된 일일 프롬프트가 없습니다"}</h2>
              </div>
              {latestPrompt?.data.notionUrl ? (
                <a
                  href={latestPrompt.data.notionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  Notion에서 열기
                </a>
              ) : null}
            </div>
            {latestPrompt ? (
              <>
                <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
                  <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-900">{latestPrompt.data.mode}</span>
                  <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-900">{latestPrompt.data.status}</span>
                  <span className="rounded-full bg-zinc-100 px-2.5 py-1 dark:bg-zinc-900">{latestPrompt.data.promptVersion}</span>
                </div>
                <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950 p-4 text-xs leading-5 text-zinc-200">
                  {latestPrompt.data.prompt.slice(0, 6000)}
                </pre>
              </>
            ) : (
              <p className="py-8 text-sm text-zinc-500">GitHub Actions 또는 /api/cron/daily를 한 번 실행하면 생성됩니다.</p>
            )}
          </section>

          {connections.wordpress.configured ? (
            <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">최근 WordPress 글</h2>
                <span className="text-xs text-zinc-500">최대 8개</span>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {latestArticles.length === 0 ? (
                  <p className="py-6 text-sm text-zinc-500">연결은 되어 있지만 아직 동기화된 글이 없습니다.</p>
                ) : (
                  latestArticles.map((article) => (
                    <div key={article.id} className="py-3">
                      <a href={article.data.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                        {article.data.title ?? "제목 없음"}
                      </a>
                      <p className="mt-1 text-xs text-zinc-500">{(article.data.categoryNames ?? []).join(" · ") || "카테고리 없음"}</p>
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : (
            <section className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-5 dark:border-zinc-700 dark:bg-zinc-950">
              <h2 className="font-semibold">WordPress는 현재 보류</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                프롬프트와 글 품질을 충분히 검증한 뒤 연결합니다. 지금은 WORDPRESS_BASE_URL을 비워두는 것이 정상 상태입니다.
              </p>
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="font-semibold">최근 자동 실행</h2>
            {latestRun ? (
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">트리거</dt><dd>{latestRun.data.trigger ?? "-"}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">일일 프롬프트</dt><dd>{latestRun.data.dailyPrompt?.created ? "신규 생성" : "기존 유지"}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">모드</dt><dd>{latestRun.data.dailyPrompt?.mode ?? "-"}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">Notion 문제 반영</dt><dd>{latestRun.data.notion?.problemsUpdated ?? 0}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">WordPress</dt><dd>{latestRun.data.wordpress?.configured ? `${latestRun.data.wordpress.articles ?? 0}개` : "보류"}</dd></div>
                <div className="pt-2 text-xs text-zinc-500">{latestRun.data.finishedAt ?? ""}</div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">아직 실행 기록이 없습니다.</p>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-zinc-950 p-5 text-zinc-100 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">현재 운영 계약</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              매일 생성된 프롬프트를 ChatGPT Plus에 직접 넣어 조사와 미션 품질을 먼저 검증합니다. Evidence 없이 경험담을 자동 생성하거나 WordPress에 자동 발행하지 않습니다.
            </p>
          </section>
        </div>
      </section>
    </main>
  );
}

function DashboardLoading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-5 py-10 sm:px-8">
      <section className="space-y-3">
        <p className="text-sm font-semibold text-zinc-500">Problem Solving Research</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">문제 해결소</h1>
        <p className="text-sm text-zinc-500">운영 데이터를 불러오는 중입니다.</p>
      </section>
      <section className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          />
        ))}
      </section>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardContent />
    </Suspense>
  );
}
