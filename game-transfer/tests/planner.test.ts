import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransferPlan, normalizeRemotePath } from '../src/planner.js';
import type { CatalogFile } from '../src/types.js';

const catalog: CatalogFile = {
  schema_version: 1,
  source: { month: '2026-10' },
  games: [{
    id: 123,
    source_url: 'https://acgyyg.cc/game/',
    raw_title: '【RPG】正式游戏名 V1.0【1G】',
    parsed_name: '正式游戏名',
    safe_name: '正式游戏名：特别版',
    shares: [
      { provider: 'xunlei', url: 'https://pan.xunlei.com/s/demo', code: null },
      { provider: 'baidu', url: 'https://pan.baidu.com/s/demo', code: 'a1b2' },
    ],
  }],
};

test('builds a Baidu-only transfer plan without exposing credentials in the target path', () => {
  const plan = buildTransferPlan(catalog, 'games');
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.target_dir, 'games/2026-10/正式游戏名：特别版');
  assert.equal(plan[0]?.share_code, 'a1b2');
  assert.match(plan[0]?.share_fingerprint ?? '', /^[a-f0-9]{64}$/u);
});

test('rejects remote path traversal', () => {
  assert.throws(() => normalizeRemotePath('../outside'), /不安全/u);
  assert.throws(() => normalizeRemotePath('/'), /不安全/u);
});
