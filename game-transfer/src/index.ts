import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BdpanClient } from './bdpan.js';
import { buildTransferPlan, validateCatalog } from './planner.js';
import { loadState, saveState, shouldProcess } from './state.js';
import type { CatalogFile, TransferRecord } from './types.js';

const TOOL_DIR = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

interface CliOptions {
  catalogPath: string;
  stateDir: string;
  targetRoot: string;
  bdpanBin: string;
  execute: boolean;
  retryFailed: boolean;
  postId: number | null;
  limit: number | null;
  delayMs: number;
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} 必须是正整数`);
  return parsed;
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} 必须是非负整数`);
  return parsed;
}

function parseArgs(input: string[]): CliOptions {
  const args = input[0] === '--' ? input.slice(1) : input;
  let catalogPath = '';
  let stateDir = path.join(TOOL_DIR, 'data', 'transfer-state');
  let targetRoot = 'games';
  let bdpanBin = process.env.BDPAN_BIN || 'bdpan';
  let execute = false;
  let retryFailed = false;
  let postId: number | null = null;
  let limit: number | null = null;
  let delayMs = 3000;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--catalog') catalogPath = readValue(args, index++, argument);
    else if (argument === '--state-dir') stateDir = readValue(args, index++, argument);
    else if (argument === '--target-root') targetRoot = readValue(args, index++, argument);
    else if (argument === '--bdpan-bin') bdpanBin = readValue(args, index++, argument);
    else if (argument === '--post-id') postId = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--limit') limit = positiveInteger(readValue(args, index++, argument), argument);
    else if (argument === '--delay') delayMs = nonNegativeInteger(readValue(args, index++, argument), argument);
    else if (argument === '--execute') execute = true;
    else if (argument === '--retry-failed') retryFailed = true;
    else if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    } else throw new Error(`未知参数：${argument}`);
  }

  if (!catalogPath) throw new Error('必须提供 --catalog <月度JSON>');
  return {
    catalogPath: path.resolve(catalogPath),
    stateDir: path.resolve(stateDir),
    targetRoot,
    bdpanBin,
    execute,
    retryFailed,
    postId,
    limit,
    delayMs,
  };
}

function printHelp(): void {
  console.log(`game-transfer：将 game-catalog 中的百度分享转存到自己的网盘

用法：
  pnpm start -- --catalog ../game-catalog/data/acgyyg/2026-10.json
  pnpm start -- --catalog catalog.json --limit 1 --execute

参数：
  --catalog FILE       game-catalog 生成的月度 JSON（必填）
  --state-dir DIR      状态目录，默认 data/transfer-state
  --target-root DIR    网盘应用目录内的根目录，默认 games
  --bdpan-bin FILE     bdpan 路径，默认从 PATH 查找
  --post-id ID         只处理指定 WordPress 文章
  --limit N            最多选择 N 个待处理游戏
  --delay MS           两次转存之间的等待，默认 3000ms
  --retry-failed       重试状态为 failed 的项目
  --execute            实际写入网盘；不提供时仅预览计划
`);
}

function loadLocalEnv(): void {
  if (process.env.BDPAN_BIN) return;
  try {
    process.loadEnvFile(path.join(TOOL_DIR, '.env'));
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code !== 'ENOENT') throw new Error('读取 game-transfer/.env 失败', { cause: error });
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function newRecord(item: ReturnType<typeof buildTransferPlan>[number], attempts: number): TransferRecord {
  return {
    post_id: item.post_id,
    game_name: item.game_name,
    provider: 'baidu',
    share_fingerprint: item.share_fingerprint,
    transfer_dir: item.transfer_dir,
    target_dir: item.target_dir,
    status: 'failed',
    task_id: null,
    saved_paths: [],
    transferred_items: [],
    final_path: null,
    attempts,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(await fs.readFile(options.catalogPath, 'utf8')) as unknown;
  validateCatalog(catalog);
  let plan = buildTransferPlan(catalog as CatalogFile, options.targetRoot);
  if (options.postId !== null) plan = plan.filter((item) => item.post_id === options.postId);
  if (options.limit !== null) plan = plan.slice(0, options.limit);
  if (plan.length === 0) throw new Error('没有符合条件的百度分享链接');

  console.log(`📚 月份：${catalog.source.month}`);
  console.log(`🎮 选择：${plan.length} 个游戏`);
  console.log(`🧭 模式：${options.execute ? '实际转存' : '仅预览（不会写入网盘）'}`);
  for (const [index, item] of plan.entries()) {
    console.log(`${index + 1}. [${item.post_id}] ${item.game_name}`);
    console.log(`   目标：我的应用数据/bdpan/${item.target_dir}`);
    console.log(`   提取码：${item.share_code ? '有' : '无'}`);
  }
  if (!options.execute) {
    console.log('\n未提供 --execute，计划预览完成。');
    return;
  }

  const statePath = path.join(options.stateDir, `${catalog.source.month}.json`);
  const state = await loadState(statePath, options.catalogPath, catalog.source.month);
  const client = new BdpanClient(options.bdpanBin);
  await client.assertLoggedIn();
  console.log('\n✓ bdpan 已登录，开始串行转存');

  let completed = 0;
  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, item] of plan.entries()) {
    const key = String(item.post_id);
    const existing = state.records[key];
    const decision = shouldProcess(existing, item, options.retryFailed);
    if (!decision.process) {
      skipped += 1;
      console.log(`[${index + 1}/${plan.length}] 跳过 ${item.game_name}：${decision.reason}`);
      continue;
    }

    const resumeNormalization = existing?.status === 'transferred'
      && existing.share_fingerprint === item.share_fingerprint;
    const record = resumeNormalization ? existing : newRecord(item, (existing?.attempts ?? 0) + 1);
    console.log(`[${index + 1}/${plan.length}] ${resumeNormalization ? '继续整理' : '转存'} ${item.game_name}`);
    try {
      if (!resumeNormalization) {
        const result = await client.transfer(item);
        record.status = result.status === 'completed' ? 'transferred' : 'submitted';
        record.task_id = result.taskId;
        record.saved_paths = result.savedPaths;
        record.transferred_items = result.items;
        record.updated_at = new Date().toISOString();
        state.records[key] = record;
        await saveState(statePath, state);
      }

      if (record.status === 'submitted') {
        submitted += 1;
        console.log(`  ⏳ 已提交异步任务${record.task_id ? '（任务 ID 已保存）' : ''}`);
      } else {
        const finalPaths = await client.normalizeTransferredItems(item, record.transferred_items ?? []);
        record.status = 'completed';
        record.saved_paths = finalPaths;
        record.final_path = `/apps/bdpan/${item.target_dir}`;
        record.last_error = null;
        completed += 1;
        console.log('  ✓ 转存并整理为单层正式游戏目录');
      }
    } catch (error) {
      if (record.status !== 'transferred') record.status = 'failed';
      record.last_error = error instanceof Error ? error.message : String(error);
      failed += 1;
      console.error(`  ✗ ${record.last_error}`);
    }
    record.updated_at = new Date().toISOString();
    state.records[key] = record;
    await saveState(statePath, state);
    if (options.delayMs > 0 && index < plan.length - 1) await sleep(options.delayMs);
  }

  console.log(`\n完成：${completed}，已提交：${submitted}，失败：${failed}，跳过：${skipped}`);
  console.log(`状态文件：${statePath}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error : new Error(String(error));
  console.error(`❌ ${reason.message}`);
  process.exitCode = 1;
});
