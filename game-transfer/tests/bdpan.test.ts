import assert from 'node:assert/strict';
import test from 'node:test';
import { BdpanCommandError, interpretTransferResult, parseJsonOutput, redactSensitiveText } from '../src/bdpan.js';
import type { TransferPlanItem } from '../src/types.js';

test('interprets completed transfer output', () => {
  const result = interpretTransferResult({
    saved_path: '我的应用数据/bdpan/games/demo',
    files: [{ saved_path: '我的应用数据/bdpan/games/demo/file.zip' }],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.savedPaths, [
    '我的应用数据/bdpan/games/demo',
    '我的应用数据/bdpan/games/demo/file.zip',
  ]);
});

test('interprets submitted asynchronous output without claiming completion', () => {
  const result = interpretTransferResult({ status: 'submitted', task_id: '123456' });
  assert.deepEqual(result, { status: 'submitted', taskId: '123456', savedPaths: [] });
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
    target_dir: 'games/demo',
    share_url: 'https://pan.baidu.com/s/private',
    share_code: 'a1b2',
    share_fingerprint: 'hash',
  };
  const redacted = redactSensitiveText('failed https://pan.baidu.com/s/private code a1b2', item);
  assert.equal(redacted, 'failed [分享链接已隐藏] code [提取码已隐藏]');
});
