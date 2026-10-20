import { load } from 'cheerio';

const WINDOWS_REPLACEMENTS: Readonly<Record<string, string>> = {
  '<': '＜',
  '>': '＞',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊',
};

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function decodeHtmlText(value: string): string {
  return load(`<span>${value}</span>`)('span').text();
}

export function parseGameName(rawTitle: string): string {
  return decodeHtmlText(rawTitle)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function toSafeName(name: string, maxLength = 120): string {
  let safe = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*]/gu, (character) => WINDOWS_REPLACEMENTS[character] ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[ .]+$/gu, '')
    .trim();

  safe = [...safe].slice(0, maxLength).join('').replace(/[ .]+$/gu, '');

  if (!safe) {
    safe = '未命名游戏';
  }

  const stem = safe.split('.')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    safe = `${safe}_`;
  }

  return safe;
}

export function ensureUniqueSafeNames<T extends { id: number; safe_name: string }>(games: T[]): void {
  const owners = new Map<string, number>();

  for (const game of games) {
    const key = game.safe_name.toLocaleLowerCase('zh-CN');
    const existingOwner = owners.get(key);
    if (existingOwner === undefined) {
      owners.set(key, game.id);
      continue;
    }

    game.safe_name = toSafeName(`${game.safe_name}__${game.id}`);
    owners.set(game.safe_name.toLocaleLowerCase('zh-CN'), game.id);
  }
}
