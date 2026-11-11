import { createHash } from "node:crypto";
import { env } from "@/lib/config";
import { upsertDocument } from "@/lib/firestore";

function stripHtml(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function wordpressHeaders() {
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.wordpressUsername && env.wordpressApplicationPassword) {
    headers.authorization = `Basic ${Buffer.from(
      `${env.wordpressUsername}:${env.wordpressApplicationPassword}`,
    ).toString("base64")}`;
  }
  return headers;
}

function endpoint(path: string) {
  if (!env.wordpressBaseUrl) throw new Error("WORDPRESS_BASE_URL이 설정되지 않았습니다.");
  return `${env.wordpressBaseUrl.replace(/\/$/, "")}${path}`;
}

async function fetchAll<T>(path: string) {
  const rows: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(endpoint(`${path}${separator}per_page=100&page=${page}`), {
      headers: wordpressHeaders(),
      cache: "no-store",
    });

    if (response.status === 400 && page > 1) break;
    if (!response.ok) {
      throw new Error(`WordPress API 호출 실패: ${response.status} ${await response.text()}`);
    }

    const batch = (await response.json()) as T[];
    rows.push(...batch);

    const totalPages = Number(response.headers.get("x-wp-totalpages") ?? "1");
    if (page >= totalPages || batch.length === 0) break;
    page += 1;
  }

  return rows;
}

type WpCategory = { id: number; name: string; slug: string; parent: number; count: number };
type WpPost = {
  id: number;
  date: string;
  modified: string;
  slug: string;
  status: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  categories: number[];
  tags: number[];
};

export type SyncedWordPressPost = {
  id: number;
  title: string;
  slug: string;
  link: string;
  modified: string;
};

export async function syncWordPress() {
  if (!env.wordpressBaseUrl) {
    return { skipped: true, categories: 0, articles: 0, posts: [] as SyncedWordPressPost[] };
  }

  const categories = await fetchAll<WpCategory>(
    "/wp-json/wp/v2/categories?_fields=id,name,slug,parent,count",
  );
  const categoryMap = new Map(categories.map((category) => [category.id, category]));

  for (const category of categories) {
    await upsertDocument("categories", `wp-${category.id}`, {
      source: "wordpress",
      wordpressId: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parent,
      articleCount: category.count,
      syncedAt: new Date().toISOString(),
    });
  }

  const posts = await fetchAll<WpPost>(
    "/wp-json/wp/v2/posts?_fields=id,date,modified,slug,status,link,title,content,excerpt,categories,tags",
  );

  const syncedPosts: SyncedWordPressPost[] = [];
  for (const post of posts) {
    const title = stripHtml(post.title.rendered);
    const contentText = stripHtml(post.content.rendered).slice(0, 80_000);
    const excerptText = stripHtml(post.excerpt.rendered).slice(0, 4_000);
    const categoryNames = post.categories
      .map((categoryId) => categoryMap.get(categoryId)?.name)
      .filter((name): name is string => Boolean(name));

    await upsertDocument("articles", `wp-${post.id}`, {
      source: "wordpress",
      wordpressId: post.id,
      title,
      slug: post.slug,
      url: post.link,
      status: "PUBLISHED",
      publishedAt: post.date,
      modifiedAt: post.modified,
      categoryIds: post.categories,
      categoryNames,
      tagIds: post.tags,
      excerptText,
      contentText,
      contentFingerprint: createHash("sha256").update(contentText).digest("hex"),
      searchText: `${title} ${categoryNames.join(" ")} ${excerptText}`.toLowerCase().slice(0, 8_000),
      syncedAt: new Date().toISOString(),
    });

    syncedPosts.push({ id: post.id, title, slug: post.slug, link: post.link, modified: post.modified });
  }

  return { skipped: false, categories: categories.length, articles: posts.length, posts: syncedPosts };
}
