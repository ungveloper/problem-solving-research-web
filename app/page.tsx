import { Suspense } from "react";

import { getConnectionState } from "@/lib/config";
import type { ProblemRecord } from "@/lib/domain";
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
  wordpress?: { articles?: number };
  notion?: { updated?: number };
};

async function dashboardData() {
  const connections = getConnectionState();
  if (!connections.firebase.configured) {
    return { connections, articles: [], problems: [], runs: [] };
  }

  const [articles, problems, runs] = await Promise.all([
    listDocuments<Article>("articles", 200),
    listDocuments<ProblemRecord>("problems", 200),
    listDocuments<DailyRun>("dailyRuns", 30),
  ]);

  return { connections, articles, problems, runs };
}

function ConnectionBadge({ name, configured }: { name: string; configured: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="text-sm font-medium">{name}</span>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
          configured
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        }`}
      >
        {configured ? "연결됨" : "설정 필요"}
      </span>
    </div>
  );
}

async function DashboardContent() {
  const { connections, articles, problems, runs } = await dashboardData();
  const rejected = problems.filter((item) => item.data.status === "REJECTED").length;
  const active = problems.filter((item) => ["IN_PROGRESS", "TESTING", "READY_TO_WRITE"].includes(item.data.status)).length;
  const latestArticles = [...articles]
    .sort((a, b) => String(b.data.modifiedAt ?? "").localeCompare(String(a.data.modifiedAt ?? "")))
    .slice(0, 8);
  const latestRun = [...runs].sort((a, b) => String(b.data.finishedAt ?? "").localeCompare(String(a.data.finishedAt ?? "")))[0];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-5 py-10 sm:px-8">
      <section className="space-y-3">
        <p className="text-sm font-semibold text-zinc-500">Problem Solving Research</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">문제 해결소</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              Notion은 명령을 내리는 화면, Firestore는 기억하고 판단하는 뇌, WordPress는 실제 발행 결과로 사용합니다.
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
        <ConnectionBadge name="WordPress" configured={connections.wordpress.configured} />
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ["동기화된 글", articles.length],
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

      {!connections.firebase.configured ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="text-lg font-semibold">먼저 환경변수를 연결하세요</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
            저장소의 <code>.env.example</code>과 <code>docs/notion-setup.md</code> 순서대로 Firebase, Notion, WordPress를 연결하면 이 화면이 실제 데이터로 바뀝니다.
          </p>
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[1.25fr_.75fr]">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">최근 WordPress 글</h2>
            <span className="text-xs text-zinc-500">최대 8개</span>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {latestArticles.length === 0 ? (
              <p className="py-6 text-sm text-zinc-500">아직 동기화된 글이 없습니다.</p>
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
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="font-semibold">최근 자동 실행</h2>
            {latestRun ? (
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">트리거</dt><dd>{latestRun.data.trigger ?? "-"}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">WordPress 글</dt><dd>{latestRun.data.wordpress?.articles ?? 0}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-zinc-500">Notion 반영</dt><dd>{latestRun.data.notion?.updated ?? 0}</dd></div>
                <div className="pt-2 text-xs text-zinc-500">{latestRun.data.finishedAt ?? ""}</div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">아직 실행 기록이 없습니다.</p>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-zinc-950 p-5 text-zinc-100 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">V1 원칙</p>
            <p className="mt-3 text-sm leading-6 text-zinc-300">
              글을 자동 발행하지 않습니다. 먼저 기존 글과 반려 이력을 기억하고, ChatGPT Plus에 넣을 프롬프트와 실제 Mission을 관리하는 기반부터 만듭니다.
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
