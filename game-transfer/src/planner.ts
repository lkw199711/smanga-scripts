import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CatalogFile, TransferPlanItem } from './types.js';

export function validateCatalog(value: unknown): asserts value is CatalogFile {
  if (!value || typeof value !== 'object') throw new Error('目录数据不是 JSON 对象');
  const catalog = value as Partial<CatalogFile>;
  if (catalog.schema_version !== 1) throw new Error(`不支持的目录 schema_version：${String(catalog.schema_version)}`);
  if (!catalog.source || !/^\d{4}-\d{2}$/u.test(catalog.source.month ?? '')) {
    throw new Error('目录数据缺少有效的 source.month');
  }
  if (!Array.isArray(catalog.games)) throw new Error('目录数据缺少 games 数组');
}

export function normalizeRemotePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.startsWith('~') || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`不安全的网盘目标目录：${value}`);
  }
  return normalized;
}

export function shareFingerprint(url: string, code: string | null): string {
  return createHash('sha256').update(url).update('\0').update(code ?? '').digest('hex');
}

export function buildTransferPlan(catalog: CatalogFile, targetRoot: string): TransferPlanItem[] {
  validateCatalog(catalog);
  const root = normalizeRemotePath(targetRoot);

  return catalog.games.flatMap((game) => {
    if (!Number.isInteger(game.id) || !game.safe_name || !Array.isArray(game.shares)) return [];
    const share = game.shares.find((candidate) => candidate.provider === 'baidu' && candidate.url);
    if (!share) return [];

    const transferDir = normalizeRemotePath(path.posix.join(root, catalog.source.month));
    const targetDir = normalizeRemotePath(path.posix.join(transferDir, game.safe_name));
    return [{
      post_id: game.id,
      game_name: game.parsed_name || game.raw_title || game.safe_name,
      source_url: game.source_url,
      transfer_dir: transferDir,
      target_dir: targetDir,
      share_url: share.url,
      share_code: share.code,
      share_fingerprint: shareFingerprint(share.url, share.code),
    }];
  });
}
