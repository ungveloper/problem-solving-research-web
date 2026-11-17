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

const OBSOLETE_PRINCIPLES = [
  "Evidence가 없으면 최종 경험담을 쓰지 않고 미션까지만 설계한다.",
  "Daily Research는 글쓰기 단계가 아니라 오늘 직접 확인할 Problem과 최소 행동을 정하는 단계다.",
  "Daily Research는 글쓰기 단계가 아니라 오늘 직접 확인할 Problem과 관찰 시나리오를 정하는 단계다.",
  "실제 Evidence가 들어온 뒤에만 글 가치와 Story Shape를 판단한다.",
  "Evidence가 있어도 새롭게 전달할 가치가 없으면 글을 만들지 않고 기록만 남긴다.",
  "실제로 하지 않은 행동과 결과를 사용자의 1인칭 경험으로 만들지 않는다.",
  "Daily Research는 최종 Problem을 고른 뒤 배우 관찰형 블로그 초안까지 만든다.",
  "배우의 행동은 관찰자 시점으로 자연스럽게 쓰고, 확인되지 않은 성공·실패·해결 결과는 지어내지 않는다.",
  "마지막 문단은 질문을 다시 늘어놓지 않고 현재 단계에서 독자가 가져갈 수 있는 잠정 판단 기준으로 자연스럽게 닫는다.",
];

const DEFAULT_PRINCIPLES = [
  "Daily Research의 내부 설계에서는 배우 시나리오를 사용할 수 있지만 블로그 본문에는 배우·관찰자·한 사용자라는 표현을 노출하지 않는다.",
  "블로그 초안의 행동은 화자 나의 1인칭 체험 서술로 변환해 직접 해본 것처럼 자연스럽게 쓴다.",
  "1인칭 체험형 문체는 편집·압축·이미지 계획보다 우선하는 문제 해결소의 고정 아이덴티티이며, 후속 수정으로 일반 가이드나 계획서 말투로 약화시키지 않는다.",
  "앱을 열고, 만들고, 눌러보고, 비교하고, 다시 확인한 행동은 1인칭 완료형으로 쓰되 아직 확인되지 않은 성공·실패·오류·해결 결과는 지어내지 않는다.",
  "실제 Evidence가 들어오면 초안의 1인칭 행동 흐름을 실제 OBSERVED 결과에 맞게 다시 구성하고 최종 Story Shape와 발행 가치를 판단한다.",
  "초안이 있어도 실제 결과의 독자 가치가 없으면 발행하지 않고 기록만 남길 수 있다.",
  "최종 글은 실제 경험이 필요한 형태를 스스로 결정하며 문제-원인-해결-결론 같은 고정 템플릿을 강제하지 않는다.",
  "블로그 본문에는 목표 글자 수, 최소·최대 분량, 문단 수, H2/H3 개수, 도입 방식, 전개 순서, 결론 유무, 이미지 수에 대한 고정 규칙을 두지 않는다.",
  "같은 주제군의 글이어도 이전 글의 구조나 문장 리듬을 복제하지 않고 이번 경험에 맞는 구성을 새로 만든다.",
  "블로그의 길이와 구체성은 현재 세션에서 실제 확보한 OBSERVED 경험량에 비례하며, 공식 문서·커뮤니티·향후 계획으로 장문 체험 후기처럼 부풀리지 않는다.",
  "실제로 수행한 행동만 1인칭 완료형으로 쓰고, 공식 도움말에 적힌 절차나 내부 시나리오를 직접 실행한 것처럼 꾸미지 않는다.",
  "목표 글자 수나 섹션 수를 채우기 위해 같은 질문·가설·계획을 반복하지 않고, 삭제해도 정보가 줄지 않는 문장은 제거한다.",
  "마무리는 해결 결과, 예상 밖 발견, 미해결 상태, 다음 행동, 짧은 소감 등 실제 경험에 맞게 자유롭게 끝낼 수 있고 별도 결론 문단이 없어도 된다.",
  "이미지는 이해나 증거에 필요할 때만 사용하고 실제 제품 화면·오류·전후 비교는 생성 이미지로 대체하지 않는다.",
  "이미지를 제안하면 이미지 계획뿐 아니라 블로그 본문의 실제 삽입 지점에도 같은 번호의 위치 마커를 표시한다.",
  "제목·H2·핵심 문장·마지막 판단은 실제로 확인한 Evidence 환경보다 넓게 일반화하지 않고, 도구로 확인한 범위를 OS·기기 실측 결과처럼 확대하지 않는다.",
  "현재 세션에서 직접 얻은 Evidence는 블로그 본문에 통합하고 같은 결과를 별도 상위 결과 보고서 섹션으로 반복하지 않는다.",
  "블로그 본문과 이미지 계획은 일반 Markdown만 사용하고 서식용 HTML·JSX·MDX·XML 태그나 HTML entity를 출력하지 않는다.",
  "실제로 같은 응답에 제공되지 않은 파일을 첨부·다운로드 가능한 것처럼 쓰지 않는다.",
  "이미지 계획에는 실제 캡처 또는 생성할 이미지만 남기고 검색 중 발견한 외부 참고 이미지나 썸네일을 끼워 넣지 않는다.",
  "가치 있는 신규 문제가 없으면 오늘 추천 0개를 허용한다.",
  "반려한 문제군은 다시 추천하지 않는다.",
];

function migratedPrinciples(current: string[]) {
  const isLegacyDefault =
    current.length === LEGACY_DEFAULT_PRINCIPLES.length &&
    current.every((value, index) => value === LEGACY_DEFAULT_PRINCIPLES[index]);
  if (isLegacyDefault) return DEFAULT_PRINCIPLES;

  const next = current.filter((value) => !OBSOLETE_PRINCIPLES.includes(value));
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
