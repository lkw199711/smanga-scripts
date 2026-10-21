import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { DescriptionImage, GameRecord, ShareRecord, WordPressPost } from './types.js';
import { extractFormalGameName, parseGameName, toSafeName } from './name.js';

interface ProviderInfo {
  provider: string;
  label: string;
}

const PROVIDERS: ReadonlyArray<{ matches: (host: string) => boolean; info: ProviderInfo }> = [
  { matches: (host) => host === 'pan.baidu.com', info: { provider: 'baidu', label: '百度网盘' } },
  { matches: (host) => host === 'pan.xunlei.com', info: { provider: 'xunlei', label: '迅雷云盘' } },
  { matches: (host) => host === 'share.weiyun.com' || host.endsWith('.weiyun.com'), info: { provider: 'weiyun', label: '腾讯微云' } },
  { matches: (host) => host === 'drive.uc.cn' || host.endsWith('.drive.uc.cn'), info: { provider: 'uc', label: 'UC网盘' } },
  { matches: (host) => host === 'pan.quark.cn' || host.endsWith('.pan.quark.cn'), info: { provider: 'quark', label: '夸克网盘' } },
  { matches: (host) => host === 'www.alipan.com' || host === 'alipan.com' || host.endsWith('.aliyundrive.com'), info: { provider: 'alipan', label: '阿里云盘' } },
  { matches: (host) => host === 'www.123pan.com' || host === '123pan.com' || host.endsWith('.123pan.com'), info: { provider: '123pan', label: '123云盘' } },
  { matches: (host) => /(^|\.)lanzou[a-z]?\.com$/u.test(host), info: { provider: 'lanzou', label: '蓝奏云' } },
  { matches: (host) => host === 'mypikpak.com' || host.endsWith('.mypikpak.com'), info: { provider: 'pikpak', label: 'PikPak' } },
];

const URL_PATTERN = /https?:\/\/[^\s<>"'“”‘’（）【】]+/giu;
const CODE_PATTERN = /(提取码|访问码|访问密码|分享密码|(?<!解压)密码)\s*[:：]?\s*([\p{L}\p{N}_-]{2,32})/giu;
const EXTRACT_PASSWORD_PATTERN = /(?:解压(?:码|密码)|压缩包密码)\s*[:：]?\s*([^\s，。；;]+)/iu;
const SHARE_CONTEXT_PATTERN = /(?:网盘|云盘|下载|分享|链接|地址|提取码|访问码)/iu;
const SHARE_HEADING_PATTERN = /^(?:下载地址|下载链接|资源地址|游戏地址|网盘地址|资源下载)[:：]?$/iu;

function providerFor(host: string): ProviderInfo | null {
  const normalized = host.toLowerCase().replace(/^www\./u, '');
  for (const provider of PROVIDERS) {
    if (provider.matches(host.toLowerCase()) || provider.matches(normalized)) {
      return provider.info;
    }
  }
  return null;
}

function trimUrl(value: string): string {
  let result = value.trim();
  while (/[，。；;、！!？?）】》〉]$/u.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

function textWithBreaks($: CheerioAPI, element: Element): string {
  const clone = $(element).clone();
  clone.find('br').replaceWith('\n');
  return clone.text()
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
}

function findUrls($: CheerioAPI, element: Element, text: string): string[] {
  const values = [...text.matchAll(URL_PATTERN)].map((match) => match[0]);
  $(element).find('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    if (href?.startsWith('http://') || href?.startsWith('https://')) {
      values.push(href);
    }
  });

  return [...new Set(values.map(trimUrl))];
}

function findCode(text: string, url: URL): { code: string | null; label: string | null } {
  const pwd = url.searchParams.get('pwd');
  if (pwd) {
    return { code: pwd, label: 'URL参数' };
  }

  for (const match of text.matchAll(CODE_PATTERN)) {
    if (!match[0].includes('解压')) {
      return { code: match[2] ?? null, label: match[1] ?? null };
    }
  }
  return { code: null, label: null };
}

function resolveImageUrl(rawUrl: string, sourceUrl: string): string | null {
  try {
    return new URL(rawUrl, sourceUrl).toString();
  } catch {
    return null;
  }
}

function collectImages($: CheerioAPI, content: Cheerio<AnyNode>, sourceUrl: string): DescriptionImage[] {
  const images: DescriptionImage[] = [];
  const seen = new Set<string>();

  content.find('img').each((_, image) => {
    const node = $(image);
    const rawUrl = node.attr('data-src') ?? node.attr('data-lazy-src') ?? node.attr('src');
    if (!rawUrl) return;
    const url = resolveImageUrl(rawUrl, sourceUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({ url, alt: node.attr('alt')?.trim() || null });
  });

  return images;
}

function normalizeDescriptionText(text: string): string {
  return text
    .replace(/\u00a0/gu, ' ')
    .replace(/\r/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('文章正文仍显示登录限制，请更新 ACGYYG_COOKIE 或 --cookie-file');
    this.name = 'AuthenticationRequiredError';
  }
}

export function parseArticle(post: WordPressPost, articleHtml: string): GameRecord {
  const $ = load(articleHtml);
  const content = $('.post-content').first();
  if (content.length === 0) {
    throw new Error('找不到文章正文 .post-content');
  }
  if (content.find('.erphpdown-see').length > 0 || content.text().includes('仅限注册用户')) {
    throw new AuthenticationRequiredError();
  }

  content.find('script, style, noscript').remove();
  const contentHtmlRaw = content.html()?.trim() ?? '';
  content.find('p, li, h2, h3, h4, strong').each((index, node) => {
    $(node).attr('data-game-catalog-node', String(index));
  });
  const description = content.clone();
  const shares: ShareRecord[] = [];
  let extractPassword: string | null = null;
  let shareSectionStarted = false;
  let lastRemovedBlock: Element | null = null;

  const blocks = content.find('p, li').toArray();
  for (const block of blocks) {
    const text = textWithBreaks($, block);
    const extractMatch = text.match(EXTRACT_PASSWORD_PATTERN);
    if (extractMatch?.[1]) {
      extractPassword ??= extractMatch[1];
      const marker = $(block).attr('data-game-catalog-node');
      if (marker) description.find(`[data-game-catalog-node="${marker}"]`).remove();
      lastRemovedBlock = block;
      continue;
    }

    const rawUrls = findUrls($, block, text);
    const candidates = rawUrls.flatMap((rawUrl) => {
      try {
        const url = new URL(rawUrl);
        if (url.hostname === 'acgyyg.cc' || url.hostname.endsWith('.acgyyg.cc')) return [];
        const knownProvider = providerFor(url.hostname);
        const looksLikeShare = knownProvider !== null || shareSectionStarted || SHARE_CONTEXT_PATTERN.test(text);
        return looksLikeShare ? [{ url, provider: knownProvider ?? { provider: 'unknown', label: '其他分享' } }] : [];
      } catch {
        return [];
      }
    });

    if (candidates.length === 0) continue;
    shareSectionStarted = true;
    for (const candidate of candidates) {
      if (shares.some((share) => share.url === candidate.url.toString())) continue;
      const accessCode = findCode(text, candidate.url);
      shares.push({
        ...candidate.provider,
        host: candidate.url.hostname.toLowerCase(),
        url: candidate.url.toString(),
        code: accessCode.code,
        code_label: accessCode.label,
        position: shares.length,
        raw_text: text,
        status: 'discovered',
        share_name: null,
        remote_files: [],
      });
    }
    const marker = $(block).attr('data-game-catalog-node');
    if (marker) description.find(`[data-game-catalog-node="${marker}"]`).remove();
    lastRemovedBlock = block;
  }

  if (lastRemovedBlock) {
    const sourceBlocks = content.find('p, h2, h3, h4, strong').toArray();
    for (const sourceBlock of sourceBlocks) {
      const text = textWithBreaks($, sourceBlock);
      if (!SHARE_HEADING_PATTERN.test(text)) continue;
      const nextBlocks = $(sourceBlock).nextAll('p, li').toArray();
      if (nextBlocks.some((candidate) => findUrls($, candidate, textWithBreaks($, candidate)).length > 0)) {
        const marker = $(sourceBlock).attr('data-game-catalog-node');
        if (marker) description.find(`[data-game-catalog-node="${marker}"]`).remove();
      }
    }
  }

  description.find('script, style, noscript, .erphpdown').remove();
  description.find('[data-game-catalog-node]').removeAttr('data-game-catalog-node');
  const images = collectImages($, description, post.link);
  const descriptionHtml = description.html()?.trim() ?? '';
  const descriptionText = normalizeDescriptionText(description.text());
  const rawTitle = parseGameName(post.title.rendered);
  const parsedName = extractFormalGameName(rawTitle);
  const warnings: string[] = [];
  if (shares.length === 0) warnings.push('未发现分享链接');
  if (!descriptionText) warnings.push('游戏简介为空');

  return {
    id: post.id,
    published_at: `${post.date}+08:00`,
    published_at_gmt: `${post.date_gmt}Z`,
    modified_at: `${post.modified}+08:00`,
    source_url: post.link,
    slug: post.slug,
    raw_title: rawTitle,
    parsed_name: parsedName,
    safe_name: toSafeName(parsedName),
    name_override: null,
    name_confidence: parsedName === rawTitle ? 'source-title' : 'heuristic',
    description: { text: descriptionText, html: descriptionHtml, images },
    shares,
    extract_password: extractPassword,
    content_html_raw: contentHtmlRaw,
    warnings,
  };
}
