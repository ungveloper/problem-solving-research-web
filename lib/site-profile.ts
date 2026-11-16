import { env } from "@/lib/config";
import type { SiteProfileRecord } from "@/lib/domain";
import { getDocument, upsertDocument } from "@/lib/firestore";

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

const DEFAULT_PRINCIPLES = [
  "실제로 하지 않은 행동을 1인칭 경험으로 만들지 않는다.",
  "Evidence가 없으면 최종 경험담을 쓰지 않고 미션까지만 설계한다.",
  "SEO 형식을 맞추기 위해 글자 수, H2, FAQ, 표, 내부 링크, 이미지 수를 강제하지 않는다.",
  "가치 있는 신규 문제가 없으면 오늘 추천 0개를 허용한다.",
  "반려한 문제군은 다시 추천하지 않는다.",
];

export async function ensureSiteProfile() {
  const id = env.siteId;
  const existing = await getDocument<SiteProfileRecord>("siteProfiles", id);
  if (existing) return existing;

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
