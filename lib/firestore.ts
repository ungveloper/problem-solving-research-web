import { env } from "@/lib/config";
import { getGoogleAccessToken } from "@/lib/google-auth";

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

type FirestoreDocument = {
  name: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
};

export type StoredDocument<T = Record<string, unknown>> = {
  id: string;
  data: T;
  createTime?: string;
  updateTime?: string;
};

function assertProjectId() {
  if (!env.firebaseProjectId) {
    throw new Error("FIREBASE_PROJECT_ID가 설정되지 않았습니다.");
  }
  return env.firebaseProjectId;
}

function baseUrl() {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(assertProjectId())}/databases/(default)/documents`;
}

function toValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toValue) } };
  }
  if (typeof value === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) fields[key] = toValue(child);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  return null;
}

function encodeFields(data: Record<string, unknown>) {
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) fields[key] = toValue(value);
  }
  return fields;
}

function decodeFields(fields: Record<string, FirestoreValue>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromValue(value)]));
}

async function firestoreFetch(path: string, init: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  return response;
}

export async function getDocument<T = Record<string, unknown>>(collection: string, id: string) {
  const response = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Firestore 문서 조회 실패: ${response.status} ${await response.text()}`);
  }

  const doc = (await response.json()) as FirestoreDocument;
  return {
    id,
    data: decodeFields(doc.fields ?? {}) as T,
    createTime: doc.createTime,
    updateTime: doc.updateTime,
  } satisfies StoredDocument<T>;
}

export async function upsertDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
) {
  const response = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: encodeFields(data) }),
  });

  if (!response.ok) {
    throw new Error(`Firestore 문서 저장 실패: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as FirestoreDocument;
}

export async function patchDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
) {
  const params = new URLSearchParams();
  for (const key of Object.keys(data)) params.append("updateMask.fieldPaths", key);

  const response = await firestoreFetch(
    `/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?${params.toString()}`,
    {
      method: "PATCH",
      body: JSON.stringify({ fields: encodeFields(data) }),
    },
  );

  if (!response.ok) {
    throw new Error(`Firestore 문서 부분 저장 실패: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as FirestoreDocument;
}

export async function listDocuments<T = Record<string, unknown>>(
  collection: string,
  maxDocuments = 500,
) {
  const results: StoredDocument<T>[] = [];
  let pageToken: string | undefined;

  while (results.length < maxDocuments) {
    const params = new URLSearchParams({ pageSize: String(Math.min(100, maxDocuments - results.length)) });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await firestoreFetch(`/${encodeURIComponent(collection)}?${params.toString()}`);
    if (response.status === 404) return results;
    if (!response.ok) {
      throw new Error(`Firestore 컬렉션 조회 실패: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      documents?: FirestoreDocument[];
      nextPageToken?: string;
    };

    for (const doc of payload.documents ?? []) {
      const id = doc.name.split("/").pop() ?? doc.name;
      results.push({
        id,
        data: decodeFields(doc.fields ?? {}) as T,
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      });
    }

    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  return results;
}
