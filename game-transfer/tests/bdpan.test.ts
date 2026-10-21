import assert from 'node:assert/strict';
import test from 'node:test';
import { BdpanCommandError, interpretTransferResult, parseJsonOutput, redactSensitiveText } from '../src/bdpan.js';
import type { TransferPlanItem } from '../src/types.js';

test('interprets completed transfer output', () => {
  const result = interpretTransferResult({
    saved_path: '我的应用数据/bdpan/games/demo',
    files: [{
      name: 'share-name',
      path: '/apps/bdpan/games/share-name',
      saved_path: '我的应用数据/bdpan/games/share-name',
      is_dir: true,
    }],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.savedPaths, ['我的应用数据/bdpan/games/share-name']);
  assert.deepEqual(result.items, [{
    name: 'share-name',
    path: '/apps/bdpan/games/share-name',
    saved_path: '我的应用数据/bdpan/games/share-name',
    is_dir: true,
  }]);
});

test('interprets submitted asynchronous output without claiming completion', () => {
  const result = interpretTransferResult({ status: 'submitted', task_id: '123456' });
  assert.deepEqual(result, { status: 'submitted', taskId: '123456', savedPaths: [], items: [] });
});

test('treats non-zero errno as an error', () => {
  assert.throws(() => interpretTransferResult({ errno: 13004, message: '分享失效' }), BdpanCommandError);
});

test('parses JSON after a harmless CLI banner', () => {
  assert.deepEqual(parseJsonOutput('notice\n{"status":"submitted","task_id":"1"}'), {
    status: 'submitted', task_id: '1',
  });
});

test('redacts the URL and extraction code from errors', () => {
  const item: TransferPlanItem = {
    post_id: 1,
    game_name: 'demo',
    source_url: 'https://acgyyg.cc/demo',
    transfer_dir: 'games/2026-10',
    target_dir: 'games/demo',
    share_url: 'https://pan.baidu.com/s/private',
    share_code: 'a1b2',
    share_fingerprint: 'hash',
  };
  const redacted = redactSensitiveText('failed https://pan.baidu.com/s/private code a1b2', item);
  assert.equal(redacted, 'failed [分享链接已隐藏] code [提取码已隐藏]');
});
