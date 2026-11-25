import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFormalGameName, parseGameName, toSafeName } from '../src/name.js';

test('decodes the source title and creates a cross-platform safe directory name', () => {
  const parsed = parseGameName('Alice &amp; Bob: A/B?');
  assert.equal(parsed, 'Alice & Bob: A/B?');
  assert.equal(toSafeName(parsed), 'Alice & Bob： A／B？');
});

test('handles empty and Windows-reserved names', () => {
  assert.equal(toSafeName('...'), '未命名游戏');
  assert.equal(toSafeName('CON'), 'CON_');
});

test('extracts a formal game name from release metadata', () => {
  assert.equal(
    extractFormalGameName('【像素互动SLG/中文/动态】不知怎的我经营了剑道馆-秘密的 NTR V1.1.0 官方中文步兵版+存档【新步兵/650M】'),
    '不知怎的我经营了剑道馆-秘密的 NTR',
  );
  assert.equal(
    extractFormalGameName('【3D/汉化】夏日聚集地-与辣妹们共度的秘密放学后-AI汉化版+存档【5.5G】'),
    '夏日聚集地-与辣妹们共度的秘密放学后',
  );
  assert.equal(extractFormalGameName('【SLG/中文】NTREX 官方中文版【新作】'), 'NTREX');
});
