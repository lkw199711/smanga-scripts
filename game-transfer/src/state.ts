import fs from 'node:fs/promises';
import path from 'node:path';
import type { TransferPlanItem, TransferRecord, TransferStateFile } from './types.js';

export async function loadState(
  statePath: string,
  catalogPath: string,
  month: string,
): Promise<TransferStateFile> {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as TransferStateFile;
    if (state.schema_version !== 1 || !state.records) throw new Error('状态文件格式无效');
    return state;
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code !== 'ENOENT') throw error;
    return {
      schema_version: 1,
      source: { catalog_path: catalogPath, month },
      updated_at: new Date().toISOString(),
      records: {},
    };
  }
}

export async function saveState(statePath: string, state: TransferStateFile): Promise<void> {
  state.updated_at = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, statePath);
}

export function clearStateRecord(state: TransferStateFile, postId: number): TransferRecord | null {
  const key = String(postId);
  const existing = state.records[key];
  if (!existing) return null;
  delete state.records[key];
  return existing;
}

export function shouldProcess(
  existing: TransferRecord | undefined,
  item: TransferPlanItem,
  retryFailed: boolean,
): { process: boolean; reason: string | null } {
  if (!existing || existing.share_fingerprint !== item.share_fingerprint) return { process: true, reason: null };
  if (existing.status === 'completed') return { process: false, reason: '已经完成' };
  if (existing.status === 'submitted') return { process: false, reason: '任务已提交，禁止重复提交' };
  if (existing.status === 'transferred') return { process: true, reason: '转存已完成，继续整理目录' };
  if (existing.status === 'failed' && !retryFailed) return { process: false, reason: '上次失败；使用 --retry-failed 才会重试' };
  return { process: true, reason: null };
}

export function needsLegacyLayoutRepair(
  existing: TransferRecord | undefined,
  item: TransferPlanItem,
): boolean {
  return existing?.status === 'completed'
    && existing.share_fingerprint === item.share_fingerprint
    && existing.layout_version !== 2;
}
