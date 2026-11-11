import { createSign } from "node:crypto";
import { env } from "@/lib/config";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: CachedToken | null = null;

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createAssertion() {
  if (!env.firebaseClientEmail || !env.firebasePrivateKey) {
    throw new Error("Firebase 서비스 계정 환경변수가 설정되지 않았습니다.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: env.firebaseClientEmail,
      scope: DATASTORE_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const privateKey = env.firebasePrivateKey.replace(/\\n/g, "\n");
  const signature = base64Url(signer.sign(privateKey));
  return `${unsignedToken}.${signature}`;
}

export async function getGoogleAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.accessToken;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createAssertion(),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Google OAuth 토큰 발급 실패: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(1, data.expires_in - 60) * 1000,
  };

  return cachedToken.accessToken;
}
