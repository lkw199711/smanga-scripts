import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGameName, toSafeName } from '../src/name.js';

test('decodes the source title and creates a cross-platform safe directory name', () => {
  const parsed = parseGameName('Alice &amp; Bob: A/B?');
  assert.equal(parsed, 'Alice & Bob: A/B?');
  assert.equal(toSafeName(parsed), 'Alice & Bob： A／B？');
});

test('handles empty and Windows-reserved names', () => {
  assert.equal(toSafeName('...'), '未命名游戏');
  assert.equal(toSafeName('CON'), 'CON_');
});
