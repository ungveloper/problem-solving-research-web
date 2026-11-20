import type { DailyPromptRecord, ProblemRecord } from "@/lib/domain";

// Reporting only: these names never restrict candidate discovery or publication.
// Exact, unambiguous legacy names are recognized; otherwise a service is unknown.
const SERVICE_ALIASES: Array<{ label: string; terms: RegExp[] }> = [
  { label: "Google Drive", terms: [/google\s*drive/i, /구글\s*드라이브/i] },
  { label: "Google Photos", terms: [/google\s*photos/i, /구글\s*포토/i] },
  { label: "Google Maps", terms: [/google\s*maps?/i, /구글\s*지도/i] },
  { label: "OneDrive", terms: [/one\s*drive/i, /원\s*드라이브/i] },
  { label: "iCloud Drive", terms: [/icloud\s*drive/i, /아이클라우드\s*드라이브/i] },
  { label: "iCloud", terms: [/icloud/i, /아이클라우드/i] },
  { label: "카카오톡", terms: [/카카오톡/i, /kakao\s*talk/i] },
  { label: "카카오맵", terms: [/카카오\s*맵/i, /kakao\s*map/i] },
  { label: "네이버 지도", terms: [/네이버\s*지도/i, /naver\s*map/i] },
  { label: "Gmail", terms: [/gmail/i, /지메일/i] },
  { label: "YouTube", terms: [/youtube/i, /유튜브/i] },
  { label: "Netflix", terms: [/netflix/i, /넷플릭스/i] },
  { label: "ChatGPT", terms: [/chat\s*gpt/i, /챗\s*gpt/i] },
  { label: "Notion", terms: [/notion/i, /노션/i] },
  { label: "쿠팡", terms: [/쿠팡/i, /coupang/i] },
  { label: "네이버페이", terms: [/네이버\s*페이/i, /naver\s*pay/i] },
  { label: "카카오페이", terms: [/카카오\s*페이/i, /kakao\s*pay/i] },
  { label: "Chrome", terms: [/chrome/i, /크롬/i] },
  { label: "Safari", terms: [/safari/i, /사파리/i] },
  { label: "Windows", terms: [/windows/i, /윈도우/i] },
  { label: "macOS", terms: [/macos/i, /맥\s*os/i] },
];

// Broad behavioral groups, not a permitted-topics whitelist. Prefer explicit metadata
// for new selections and fall back to these signals only for old records.
const FAMILY_SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  { label: "동기화·연동", pattern: /동기화|싱크|연동|sync|연결\s*해제|불일치/iu },
  { label: "백업·복구·이전", pattern: /백업|복구|복원|데이터\s*이전|기기\s*변경|backup|restore/iu },
  { label: "로그인·인증·계정", pattern: /로그인|인증|패스키|계정|비밀번호|2단계|접속\s*불가/iu },
  { label: "결제·구독·환불", pattern: /결제|구독|환불|청구|요금|billing|payment/iu },
  { label: "사진·영상 관리", pattern: /사진|영상|동영상|카메라|앨범|갤러리|photo|video/iu },
  { label: "문서·파일 관리", pattern: /파일|문서|폴더|압축|zip|pdf|서식|확장자|변환/iu },
  { label: "메신저·알림", pattern: /채팅|메신저|메시지|알림|메일|연락처|문자/iu },
  { label: "지도·이동·예약", pattern: /지도|위치|교통|길찾기|여행|예약|체크인/iu },
  { label: "재생·스트리밍", pattern: /스트리밍|재생|자막|오디오|음성|음악|소리/iu },
  { label: "쇼핑·배송", pattern: /쇼핑|주문|배송|택배|쿠폰|멤버십/iu },
  { label: "권한·보안 설정", pattern: /권한|보안|개인정보|접근\s*허용|설정\s*초기화/iu },
  { label: "기기·주변기기 연결", pattern: /블루투스|bluetooth|usb|스마트홈|스마트기기|기기\s*연결/iu },
  { label: "생산성·협업", pattern: /스프레드시트|캘린더|일정|메모|협업|작업\s*관리/iu },
  { label: "AI·검색", pattern: /ai\b|인공지능|검색|프롬프트|생성형/iu },
  { label: "공공·전자문서", pattern: /공공|정부|민원|전자문서|신청서/iu },
  { label: "웹·사이트 운영", pattern: /웹사이트|홈페이지|블로그|도메인|호스팅|워드프레스/iu },
];

export type RecentDailyChoice = {
  id: string;
  dateKey: string;
  data: Pick<DailyPromptRecord, "selectionDecision" | "linkedProblemId">;
};
export type DiversityProblem = {
  id: string;
  data: Pick<
    ProblemRecord,
    "title" | "category" | "detailArea" | "serviceName" | "problemFamily" | "selectedAt" | "sourceDailyPromptDateKey"
  >;
};

// Strict UTC calendar arithmetic avoids KST/DST differences and invalid date keys.
function toUtcDay(dateKey: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateKey ? date : null;
}

export function previousDateKeys(dateKey: string, count = 30) {
  const start = toUtcDay(dateKey);
  if (!start) throw new Error(`잘못된 일일 프롬프트 날짜: ${dateKey}`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime());
    date.setUTCDate(date.getUTCDate() - (index + 1));
    return date.toISOString().slice(0, 10);
  });
}

function serviceOf(problem: DiversityProblem["data"]): string | null {
  const explicit = problem.serviceName?.trim();
  if (explicit && !/^(없음|미상|해당\s*없음|비특정|서비스\s*비특정|none|n\/a)$/iu.test(explicit)) {
    const alias = SERVICE_ALIASES.find((s) => s.terms.some((pattern) => pattern.test(explicit)));
    return alias?.label ?? explicit.replace(/\s+/g, " ").slice(0, 48);
  }
  // Legacy records have no serviceName. Do not guess from the category alone.
  const text = `${problem.title} ${problem.detailArea ?? ""}`;
  return SERVICE_ALIASES.find((s) => s.terms.some((pattern) => pattern.test(text)))?.label ?? null;
}

function familyOf(problem: DiversityProblem["data"]): string | null {
  // Explicit problemFamily is preferred; legacy fields are best-effort only.
  const explicit = problem.problemFamily?.trim();
  const source = explicit || `${problem.detailArea ?? ""} ${problem.category ?? ""} ${problem.title}`;
  const known = FAMILY_SIGNALS.find(({ pattern }) => pattern.test(source));
  if (known) return known.label;
  return explicit ? explicit.replace(/\s+/g, " ").slice(0, 48) : null;
}

function frequencies(values: Array<string | null>) {
  const map = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return [...map].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
}

export function buildRecentTopicDiversityBlock(
  dateKey: string,
  dailyChoices: RecentDailyChoice[],
  problems: DiversityProblem[],
) {
  const last30 = previousDateKeys(dateKey);
  const allowedDates = new Set(last30);
  const last7 = new Set(last30.slice(0, 7));
  const byId = new Map(problems.map((problem) => [problem.id, problem]));
  const choices: Array<{ date: string; problem: DiversityProblem["data"]; decision: string }> = [];
  const dailySeen = new Set<string>();
  const referencedProblemIds = new Set<string>();

  // A daily choice is the unit: CONTINUE on two different days counts twice.
  // Only canonical daily-YYYY-MM-DD docs are included; preview runs never inflate totals.
  for (const daily of dailyChoices) {
    const expectedId = `daily-${daily.dateKey}`;
    if (daily.id !== expectedId || !allowedDates.has(daily.dateKey) || dailySeen.has(expectedId)) continue;
    if (daily.data.selectionDecision !== "NEW" && daily.data.selectionDecision !== "CONTINUE") continue;
    const problemId = daily.data.linkedProblemId;
    const problem = problemId ? byId.get(problemId) : undefined;
    if (!problem) continue;
    dailySeen.add(expectedId);
    referencedProblemIds.add(problem.id);
    choices.push({ date: daily.dateKey, problem: problem.data, decision: daily.data.selectionDecision });
  }

  // Legacy/manual selection or preview-selected Problem without a canonical daily record:
  // add one occurrence only, and never double-count a referenced Problem.
  let fallbackChoices = 0;
  for (const problem of problems) {
    if (referencedProblemIds.has(problem.id)) continue;
    const date = problem.data.sourceDailyPromptDateKey || problem.data.selectedAt?.slice(0, 10);
    if (!date || !allowedDates.has(date)) continue;
    choices.push({ date, problem: problem.data, decision: "LEGACY" });
    fallbackChoices += 1;
  }

  const total = choices.length;
  const services = frequencies(choices.map((item) => serviceOf(item.problem)));
  const families = frequencies(choices.map((item) => familyOf(item.problem)));
  const recentServices = frequencies(choices.filter((item) => last7.has(item.date)).map((item) => serviceOf(item.problem)));
  const recentFamilies = frequencies(choices.filter((item) => last7.has(item.date)).map((item) => familyOf(item.problem)));
  const serviceMap7 = new Map(recentServices.map((value) => [value.name, value.count]));
  const familyMap7 = new Map(recentFamilies.map((value) => [value.name, value.count]));
  const serviceKnown = services.reduce((sum, item) => sum + item.count, 0);
  const familyKnown = families.reduce((sum, item) => sum + item.count, 0);
  const summarize = (items: ReturnType<typeof frequencies>) =>
    items.slice(0, 5).map(({ name, count }) => `${name} ${count}회`).join(" / ") || "분류 가능한 기록 없음";

  const lines = [
    `[최근 30일 서비스·문제군 분포 — 선택 이력 기준: ${last30[29]}~${last30[0]}]`,
    `Firestore에서 확인된 선택 기록: 총 ${total}회 (NEW ${choices.filter((item) => item.decision === "NEW").length}회, CONTINUE ${choices.filter((item) => item.decision === "CONTINUE").length}회${fallbackChoices ? `, 보조 기록 ${fallbackChoices}회` : ""}).`,
    `서비스·플랫폼 분포: ${summarize(services)}. (식별 ${serviceKnown}/${total}회)`,
    `사용자 행동·문제군 분포: ${summarize(families)}. (식별 ${familyKnown}/${total}회)`,
    "이 분포는 실제로 결과 JSON을 반영해 기록한 선택을 기준으로 한다. 아직 선택되지 않은 Daily Research 프롬프트나 검색 후보 자체는 집계하지 않는다.",
  ];

  if (total < 4) {
    lines.push("선택 기록이 4회 미만이므로 편중을 확정하거나 기계적 감점을 하지 않는다. 외부 수요 신호와 직접 검증 가치를 먼저 평가한다.");
  } else {
    const crowdedServices = services.filter((item) => item.count >= 3 || (serviceMap7.get(item.name) ?? 0) >= 2);
    const crowdedFamilies = families.filter((item) => item.count >= 3 || (familyMap7.get(item.name) ?? 0) >= 2);
    if (crowdedServices.length || crowdedFamilies.length) {
      if (crowdedServices.length) {
        lines.push(`최근 반복 서비스·플랫폼: ${crowdedServices.slice(0, 5).map((item) => `${item.name} (30일 ${item.count}회, 최근 7일 ${serviceMap7.get(item.name) ?? 0}회)`).join(" / ")}.`);
      }
      if (crowdedFamilies.length) {
        lines.push(`최근 반복 문제군: ${crowdedFamilies.slice(0, 5).map((item) => `${item.name} (30일 ${item.count}회, 최근 7일 ${familyMap7.get(item.name) ?? 0}회)`).join(" / ")}.`);
      }
      lines.push("반복 서비스 또는 문제군과 비슷한 NEW 후보는 우선순위를 낮춰 비교한다. 특히 동일 서비스+동일 사용자 행동·불편 패턴의 연속 제안은 신중히 평가한다.");
    } else {
      lines.push("현재 기록에서 뚜렷한 서비스·문제군 편중은 감지되지 않았다. 새로운 후보를 억지로 특정 영역에 할당하지 않는다.");
    }
  }

  lines.push(
    "이는 탐색 편향을 보정하는 참고 지표이지 금지 목록이나 자동 반려 기준이 아니다. 새롭고 반복되는 외부 수요 증거와 독립적인 Evidence 가치가 강하면 같은 서비스·문제군도 허용하되 선정 이유를 설명한다.",
    "최근 덜 다룬 사용자 행동·생활 장면도 외부 검색으로 적극 확인한다. 단, 수요가 약한 주제를 다양성만을 이유로 채택하지 않는다. 기존 전체 Problem 중복·반려 규칙과 CONTINUE의 실제 다음 검증 가치가 우선한다.",
    "과거 기록의 서비스·문제군이 확인되지 않으면 미분류로 남긴다. 추정 분류를 실제 웹 검색량이나 독자 수요로 해석하지 않는다.",
  );
  return lines.join("\n");
}
