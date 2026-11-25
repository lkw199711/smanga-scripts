import type { CatalogFile, CrawlFailure, GameRecord, WordPressPost } from './types.js';
import { ensureUniqueSafeNames, parseGameName } from './name.js';
import { AuthenticationRequiredError, parseArticle } from './parser.js';

const SITE_URL = 'https://acgyyg.cc';
const API_URL = `${SITE_URL}/wp-json/wp/v2/posts`;

export interface CrawlOptions {
  month: string;
  cookie: string;
  categoryId: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
  onProgress?: (completed: number, total: number, title: string) => void;
}

function monthRange(month: string): { after: string; before: string } {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (!match) throw new Error('--month 必须使用 YYYY-MM 格式');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new Error('--month 的月份必须在 01 到 12 之间');

  const startUtc = Date.UTC(year, monthNumber - 1, 1) - 8 * 60 * 60 * 1000;
  const endUtc = Date.UTC(year, monthNumber, 1) - 8 * 60 * 60 * 1000;
  return {
    after: new Date(startUtc - 1000).toISOString(),
    before: new Date(endUtc).toISOString(),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, retries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function listPosts(options: CrawlOptions): Promise<WordPressPost[]> {
  const range = monthRange(options.month);
  const firstUrl = new URL(API_URL);
  firstUrl.searchParams.set('categories', String(options.categoryId));
  firstUrl.searchParams.set('after', range.after);
  firstUrl.searchParams.set('before', range.before);
  firstUrl.searchParams.set('per_page', '100');
  firstUrl.searchParams.set('page', '1');
  firstUrl.searchParams.set('orderby', 'date');
  firstUrl.searchParams.set('order', 'asc');
  firstUrl.searchParams.set('_fields', 'id,date,date_gmt,modified,slug,link,title');

  const headers = { Accept: 'application/json', 'User-Agent': 'smanga-scripts-game-catalog/0.1' };
  const firstResponse = await fetchWithRetry(firstUrl.toString(), { headers }, options.timeoutMs);
  const posts = await firstResponse.json() as WordPressPost[];
  const totalPages = Number(firstResponse.headers.get('x-wp-totalpages') ?? '1');

  for (let page = 2; page <= totalPages; page += 1) {
    const pageUrl = new URL(firstUrl);
    pageUrl.searchParams.set('page', String(page));
    const response = await fetchWithRetry(pageUrl.toString(), { headers }, options.timeoutMs);
    posts.push(...await response.json() as WordPressPost[]);
  }

  return posts.filter((post) => post.date.startsWith(`${options.month}-`));
}

async function fetchGame(post: WordPressPost, options: CrawlOptions): Promise<GameRecord> {
  const response = await fetchWithRetry(post.link, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: options.cookie,
      'User-Agent': 'smanga-scripts-game-catalog/0.1',
    },
  }, options.timeoutMs);
  return parseArticle(post, await response.text());
}

export async function crawlMonth(options: CrawlOptions): Promise<CatalogFile> {
  if (!options.cookie.trim()) throw new Error('缺少登录 Cookie，请设置 ACGYYG_COOKIE 或使用 --cookie-file');
  const posts = await listPosts(options);
  const games: GameRecord[] = [];
  const failures: CrawlFailure[] = [];
  let nextIndex = 0;
  let completed = 0;
  let authenticationError: AuthenticationRequiredError | null = null;

  async function worker(): Promise<void> {
    while (!authenticationError) {
      const index = nextIndex;
      nextIndex += 1;
      const post = posts[index];
      if (!post) return;
      if (options.delayMs > 0 && index > 0) await sleep(options.delayMs);

      try {
        games.push(await fetchGame(post, options));
      } catch (error) {
        if (error instanceof AuthenticationRequiredError) {
          authenticationError = error;
          return;
        }
        failures.push({
          id: post.id,
          source_url: post.link,
          title: parseGameName(post.title.rendered),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        completed += 1;
        options.onProgress?.(completed, posts.length, parseGameName(post.title.rendered));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(posts.length, 1)) }, worker));
  if (authenticationError) throw authenticationError;

  games.sort((left, right) => left.published_at.localeCompare(right.published_at) || left.id - right.id);
  ensureUniqueSafeNames(games);

  const providerCounts: Record<string, number> = {};
  for (const game of games) {
    for (const share of game.shares) {
      providerCounts[share.provider] = (providerCounts[share.provider] ?? 0) + 1;
    }
  }

  return {
    schema_version: 1,
    source: {
      site: SITE_URL,
      category_id: options.categoryId,
      month: options.month,
      fetched_at: new Date().toISOString(),
    },
    summary: {
      discovered: posts.length,
      scraped: games.length,
      failed: failures.length,
      articles_without_shares: games.filter((game) => game.shares.length === 0).length,
      provider_counts: Object.fromEntries(Object.entries(providerCounts).sort(([a], [b]) => a.localeCompare(b))),
    },
    games,
    failures,
  };
}
