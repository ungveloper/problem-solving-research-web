import { env } from "@/lib/config";
import type { SiteProfileRecord } from "@/lib/domain";
import { getDocument, patchDocument, upsertDocument } from "@/lib/firestore";

const DEFAULT_SCOPES = [
  "Mac",
  "iPhone",
  "Windows",
  "Chrome / Safari",
  "WordPress",
  "ChatGPT / AI 도구",
  "PDF",
  "Excel / Numbers / Google Sheets",
  "파일 변환",
  "외장 SSD / USB",
  "클라우드",
  "웹사이트 운영",
  "웹서비스 오류",
];

const LEGACY_DEFAULT_PRINCIPLES = [
  "실제로 하지 않은 행동을 1인칭 경험으로 만들지 않는다.",
  "Evidence가 없으면 최종 경험담을 쓰지 않고 미션까지만 설계한다.",
  "SEO 형식을 맞추기 위해 글자 수, H2, FAQ, 표, 내부 링크, 이미지 수를 강제하지 않는다.",
  "가치 있는 신규 문제가 없으면 오늘 추천 0개를 허용한다.",
  "반려한 문제군은 다시 추천하지 않는다.",
];

const DEFAULT_PRINCIPLES = [
  "실제로 하지 않은 행동과 결과를 1인칭 경험으로 만들지 않는다.",
  "Daily Research는 글쓰기 단계가 아니라 오늘 직접 확인할 Problem과 최소 행동을 정하는 단계다.",
  "실제 Evidence가 들어온 뒤에만 글 가치와 Story Shape를 판단한다.",
  "Evidence가 있어도 새롭게 전달할 가치가 없으면 글을 만들지 않고 기록만 남긴다.",
  "최종 글은 실제 사건 흐름을 따르고 문제-원인-해결-결론 같은 고정 템플릿을 강제하지 않는다.",
  "가치 있는 신규 문제가 없으면 오늘 추천 0개를 허용한다.",
  "반려한 문제군은 다시 추천하지 않는다.",
];

function migratedPrinciples(current: string[]) {
  const isLegacyDefault =
    current.length === LEGACY_DEFAULT_PRINCIPLES.length &&
    current.every((value, index) => value === LEGACY_DEFAULT_PRINCIPLES[index]);
  if (isLegacyDefault) return DEFAULT_PRINCIPLES;

  const next = current.filter(
    (value) => value !== "Evidence가 없으면 최종 경험담을 쓰지 않고 미션까지만 설계한다.",
  );
  for (const principle of DEFAULT_PRINCIPLES) {
    if (!next.includes(principle)) next.push(principle);
  }
  return next;
}

export async function ensureSiteProfile() {
  const id = env.siteId;
  const existing = await getDocument<SiteProfileRecord>("siteProfiles", id);
  if (existing) {
    const principles = migratedPrinciples(existing.data.principles ?? []);
    if (JSON.stringify(principles) !== JSON.stringify(existing.data.principles ?? [])) {
      const updatedAt = new Date().toISOString();
      await patchDocument("siteProfiles", id, { principles, updatedAt });
      return { ...existing, data: { ...existing.data, principles, updatedAt } };
    }
    return existing;
  }

  const now = new Date().toISOString();
  const profile: SiteProfileRecord = {
    siteId: id,
    phase: "PROMPT_VALIDATION",
    activeScopes: DEFAULT_SCOPES,
    principles: DEFAULT_PRINCIPLES,
    wordpressDeferred: true,
    dailyPromptTime: "08:00 Asia/Seoul",
    createdAt: now,
    updatedAt: now,
  };

  await upsertDocument("siteProfiles", id, profile);
  return { id, data: profile };
}
