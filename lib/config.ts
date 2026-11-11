export const NOTION_API_VERSION = "2026-03-11";

export const env = {
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY,
  notionApiKey: process.env.NOTION_API_KEY,
  notionDataSourceId: process.env.NOTION_DATA_SOURCE_ID,
  notionWebhookSecret: process.env.NOTION_WEBHOOK_SECRET,
  notionTitleProperty: process.env.NOTION_TITLE_PROPERTY ?? "이름",
  notionStatusProperty: process.env.NOTION_STATUS_PROPERTY ?? "상태",
  wordpressBaseUrl: process.env.WORDPRESS_BASE_URL,
  wordpressUsername: process.env.WORDPRESS_USERNAME,
  wordpressApplicationPassword: process.env.WORDPRESS_APPLICATION_PASSWORD,
  cronSecret: process.env.CRON_SECRET,
  adminSecret: process.env.ADMIN_SECRET,
  siteId: process.env.SITE_ID ?? "default",
};

export function getConnectionState() {
  const firebaseMissing = [
    ["FIREBASE_PROJECT_ID", env.firebaseProjectId],
    ["FIREBASE_CLIENT_EMAIL", env.firebaseClientEmail],
    ["FIREBASE_PRIVATE_KEY", env.firebasePrivateKey],
  ].filter(([, value]) => !value).map(([name]) => name);

  const notionMissing = [
    ["NOTION_API_KEY", env.notionApiKey],
    ["NOTION_DATA_SOURCE_ID", env.notionDataSourceId],
  ].filter(([, value]) => !value).map(([name]) => name);

  const wordpressMissing = env.wordpressBaseUrl ? [] : ["WORDPRESS_BASE_URL"];

  return {
    firebase: { configured: firebaseMissing.length === 0, missing: firebaseMissing },
    notion: { configured: notionMissing.length === 0, missing: notionMissing },
    wordpress: { configured: wordpressMissing.length === 0, missing: wordpressMissing },
  };
}

export function requireEnv(name: keyof NodeJS.ProcessEnv) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`필수 환경변수 ${String(name)}가 설정되지 않았습니다.`);
  }
  return value;
}
