import assert from 'node:assert/strict';
import test from 'node:test';
import { clearStateRecord, needsLegacyLayoutRepair, shouldProcess } from '../src/state.js';
import type { TransferPlanItem, TransferRecord, TransferStateFile } from '../src/types.js';

const item: TransferPlanItem = {
  post_id: 1,
  game_name: 'demo',
  source_url: 'https://acgyyg.cc/demo',
  transfer_dir: 'games/2026-10',
  target_dir: 'games/2026-10/demo',
  share_url: 'https://pan.baidu.com/s/demo',
  share_code: 'abcd',
  share_fingerprint: 'new-hash',
};

function record(status: TransferRecord['status'], fingerprint = item.share_fingerprint): TransferRecord {
  return {
    post_id: 1,
    game_name: 'demo',
    provider: 'baidu',
    share_fingerprint: fingerprint,
    transfer_dir: item.transfer_dir,
    target_dir: item.target_dir,
    status,
    task_id: status === 'submitted' ? 'task-1' : null,
    saved_paths: [],
    transferred_items: [],
    final_path: null,
    attempts: 1,
    last_error: null,
    updated_at: new Date(0).toISOString(),
  };
}

test('never resubmits completed or submitted work with the same link', () => {
  assert.equal(shouldProcess(record('completed'), item, true).process, false);
  assert.equal(shouldProcess(record('submitted'), item, true).process, false);
});

test('retries failures only when explicitly requested', () => {
  assert.equal(shouldProcess(record('failed'), item, false).process, false);
  assert.equal(shouldProcess(record('failed'), item, true).process, true);
});

test('resumes directory normalization without resubmitting the share', () => {
  assert.equal(shouldProcess(record('transferred'), item, false).process, true);
});

test('processes a changed share link even if the old one completed', () => {
  assert.equal(shouldProcess(record('completed', 'old-hash'), item, false).process, true);
});

test('recognizes only matching legacy completed records as repairable', () => {
  const legacy = record('completed');
  assert.equal(needsLegacyLayoutRepair(legacy, item), true);
  legacy.layout_version = 2;
  assert.equal(needsLegacyLayoutRepair(legacy, item), false);
  assert.equal(needsLegacyLayoutRepair(record('failed'), item), false);
  assert.equal(needsLegacyLayoutRepair(record('completed', 'old-hash'), item), false);
});

test('clears only the requested transfer record', () => {
  const first = record('completed');
  const second = { ...record('failed'), post_id: 2 };
  const state: TransferStateFile = {
    schema_version: 1,
    source: { catalog_path: '/catalog.json', month: '2026-10' },
    updated_at: new Date(0).toISOString(),
    records: { '1': first, '2': second },
  };
  assert.equal(clearStateRecord(state, 1), first);
  assert.deepEqual(Object.keys(state.records), ['2']);
  assert.equal(clearStateRecord(state, 999), null);
  assert.deepEqual(Object.keys(state.records), ['2']);
});
