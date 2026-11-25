import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { crawlMonth } from './crawler.js';

const TOOL_DIR = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

interface CliOptions {
  month: string;
  output: string;
  cookieFile: string | null;
  categoryId: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
}

function currentShanghaiMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${option} 必须是正整数`);
  return number;
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] === '--') args = args.slice(1);
  let month = currentShanghaiMonth();
  let output: string | null = process.env.GAME_CATALOG_OUTPUT_DIR ?? null;
  let cookieFile: string | null = null;
  let categoryId = 5;
  let concurrency = 2;
  let delayMs = 500;
  let timeoutMs = 30_000;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--month') month = readValue(args, index++, argument);
    else if (argument === '--output') output = readValue(args, index++, argument);
    else if (argument === '--cookie-file') cookieFile = readValue(args, index++, argument);
    else if (argument === '--category') categoryId = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--concurrency') concurrency = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--delay') delayMs = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--timeout') timeoutMs = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  return {
    month,
    output: path.resolve(output ?? path.join(TOOL_DIR, 'data', 'acgyyg')),
    cookieFile,
    categoryId,
    concurrency,
    delayMs,
    timeoutMs,
  };
}

function loadLocalEnv(): void {
  if (process.env.ACGYYG_COOKIE) return;

  const envPath = path.join(TOOL_DIR, '.env');
  try {
    process.loadEnvFile(envPath);
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code !== 'ENOENT') {
      throw new Error(`读取 ${envPath} 失败`, { cause: error });
    }
  }
}

function printHelp(): void {
  console.log(`game-catalog：按月抓取 ACG嘤嘤怪的电脑游戏资料

用法：
  pnpm start -- --month 2026-10
  pnpm start -- --month 2026-10 --cookie-file ./cookie.txt --output ./data/acgyyg

参数：
  --month YYYY-MM     抓取月份，默认上海时区的当前月份
  --output DIR        输出目录，默认 data/acgyyg
  --cookie-file FILE  从文件读取登录 Cookie
  --category ID       WordPress 分类 ID，默认 5（电脑游戏）
  --concurrency N     文章并发数，默认 2
  --delay MS          每次文章请求前的间隔，默认 500ms
  --timeout MS        单次请求超时，默认 30000ms

Cookie 也可以通过 ACGYYG_COOKIE 环境变量传入。命令行不接受 Cookie 明文。`);
}

async function readCookie(cookieFile: string | null): Promise<string> {
  if (cookieFile) return (await fs.readFile(path.resolve(cookieFile), 'utf8')).trim();
  return process.env.ACGYYG_COOKIE?.trim() ?? '';
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  const cookie = await readCookie(options.cookieFile);
  console.log(`🎮 抓取月份：${options.month}`);
  console.log(`📂 输出目录：${options.output}`);

  const catalog = await crawlMonth({
    ...options,
    cookie,
    onProgress(completed, total, title) {
      console.log(`[${completed}/${total}] ${title}`);
    },
  });

  const outputFile = path.join(options.output, `${options.month}.json`);
  await writeJsonAtomically(outputFile, catalog);
  console.log(`\n✅ 已写入 ${outputFile}`);
  console.log(`文章：${catalog.summary.scraped}/${catalog.summary.discovered}，失败：${catalog.summary.failed}`);
  console.log(`分享方式：${JSON.stringify(catalog.summary.provider_counts)}`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error : new Error(String(error));
  console.error(`❌ ${reason.message}`);
  process.exitCode = 1;
});
