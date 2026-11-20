/* eslint-disable @typescript-eslint/no-require-imports */
// Offline test: transpile the pure reporting module. Does not contact Firestore/Notion.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/topic-diversity.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
const errors = compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (f) => f, getNewLine: () => "\n",
}));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "topic-diversity-test-"));
const tempModule = path.join(tempDir, "topic-diversity.cjs");
fs.writeFileSync(tempModule, compiled.outputText);
const { previousDateKeys, buildRecentTopicDiversityBlock } = require(tempModule);
process.on("exit", () => fs.rmSync(tempDir, { recursive: true, force: true }));

function problem(id, title, serviceName, problemFamily, date = "2026-11-18") {
  return { id, data: { title, serviceName, problemFamily, sourceDailyPromptDateKey: date } };
}
function choice(dateKey, linkedProblemId, decision = "NEW", preview = false) {
  return {
    id: `daily-${dateKey}${preview ? "-v5-preview-123" : ""}`,
    dateKey,
    data: { linkedProblemId, selectionDecision: decision },
  };
}

assert.deepEqual(previousDateKeys("2026-11-20", 2), ["2026-11-19", "2026-11-18"]);
assert.deepEqual(previousDateKeys("2026-03-01", 2), ["2026-02-28", "2026-02-27"]);
assert.throws(() => previousDateKeys("2026-02-30"), /잘못된/);

const records = [
  problem("p1", "구글 드라이브 동기화 느림", "Google Drive", "파일 동기화 지연", "2026-11-15"),
  problem("p2", "OneDrive 파일 동기화 누락", "원드라이브", "동기화 파일 누락", "2026-11-17"),
  problem("p3", "Google Drive 공유 권한", "구글 드라이브", "권한 및 접근", "2026-11-18"),
  problem("p4", "카카오톡 알림 없음", "카카오톡", "알림 누락", "2026-11-19"),
  problem("p-old", "Google Drive 복구", "Google Drive", "백업 복구", "2026-10-20"),
];
const choices = [
  choice("2026-11-15", "p1"),
  choice("2026-11-16", "p1", "CONTINUE"),
  choice("2026-11-17", "p2"),
  choice("2026-11-18", "p3"),
  choice("2026-11-19", "p4"),
  choice("2026-11-20", "p1"), // current day cannot influence itself
  choice("2026-10-20", "p-old"), // outside 30-day window
  choice("2026-11-14", "p1", "NEW", true), // preview excluded
  choice("2026-11-13", "p2", "HOLD"),
];
const report = buildRecentTopicDiversityBlock("2026-11-20", choices, records);
assert.match(report, /총 5회 \(NEW 4회, CONTINUE 1회\)/);
assert.match(report, /Google Drive 3회/);
assert.match(report, /OneDrive 1회/);
assert.match(report, /동기화·연동 3회/);
assert.match(report, /최근 반복 서비스·플랫폼: Google Drive/);
assert.match(report, /동일 서비스\+동일 사용자 행동/);
assert.match(report, /금지 목록이나 자동 반려 기준이 아니다/);
assert.doesNotMatch(report, /총 6회/);

const legacy = [{ id: "legacy", data: { title: "카카오톡 사진 파일 업로드", sourceDailyPromptDateKey: "2026-11-19" } }];
const legacyReport = buildRecentTopicDiversityBlock("2026-11-20", [], legacy);
assert.match(legacyReport, /총 1회/);
assert.match(legacyReport, /보조 기록 1회/);
assert.match(legacyReport, /카카오톡 1회/);
assert.match(legacyReport, /4회 미만이므로 편중을 확정하거나/);

const noInventedCategories = [
  { id: "only", data: { title: "새로운 실험", category: "실험", sourceDailyPromptDateKey: "2026-11-19" } },
];
const sparse = buildRecentTopicDiversityBlock("2026-11-20", [], noInventedCategories);
assert.match(sparse, /식별 0\/1회/);
assert.match(sparse, /분류 가능한 기록 없음/);
assert.doesNotMatch(sparse, /최근 반복 서비스·플랫폼/);

const noData = buildRecentTopicDiversityBlock("2026-11-20", [], []);
assert.match(noData, /총 0회/);
assert.match(noData, /편중을 확정하거나 기계적 감점을 하지 않는다/);
console.log("PASS: 최근 30일 분포·동일 Problem CONTINUE·레거시·미분류·경계 날짜·Preview 제외");
