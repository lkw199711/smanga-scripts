import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationRequiredError, parseArticle } from '../src/parser.js';
import type { WordPressPost } from '../src/types.js';

const post: WordPressPost = {
  id: 123,
  date: '2026-10-21T12:00:00',
  date_gmt: '2026-10-21T04:00:00',
  modified: '2026-10-21T12:30:00',
  slug: 'sample-game',
  link: 'https://acgyyg.cc/sample-game/',
  title: { rendered: '正式游戏名: A/B?' },
};

test('extracts description, images, every share provider and archive password', () => {
  const html = `
    <div class="post-content">
      <h2>游戏简介</h2>
      <p>这是一段游戏介绍。</p>
      <p><img data-src="/images/cover.jpg" alt="封面"></p>
      <h3>下载地址</h3>
      <p>百度网盘<br>https://pan.baidu.com/s/demo<br>提取码：b123</p>
      <p>https://pan.xunlei.com/s/demo#</p>
      <p>腾讯微云<br><a href="https://share.weiyun.com/demo">打开链接</a><br>访问码: w456</p>
      <p>备用分享：https://new-cloud.example/share/demo<br>密码：n789</p>
      <p>解压码：嘤嘤嘤</p>
    </div>`;

  const game = parseArticle(post, html);
  assert.equal(game.raw_title, '正式游戏名: A/B?');
  assert.equal(game.safe_name, '正式游戏名： A／B？');
  assert.equal(game.published_at, '2026-10-21T12:00:00+08:00');
  assert.deepEqual(game.shares.map((share) => share.provider), ['baidu', 'xunlei', 'weiyun', 'unknown']);
  assert.deepEqual(game.shares.map((share) => share.code), ['b123', null, 'w456', 'n789']);
  assert.equal(game.shares[1]?.url, 'https://pan.xunlei.com/s/demo#');
  assert.equal(game.extract_password, '嘤嘤嘤');
  assert.match(game.description.text, /这是一段游戏介绍/u);
  assert.doesNotMatch(game.description.text, /pan\.baidu/u);
  assert.deepEqual(game.description.images, [{ url: 'https://acgyyg.cc/images/cover.jpg', alt: '封面' }]);
});

test('reports an expired or missing authenticated session', () => {
  assert.throws(
    () => parseArticle(post, '<div class="post-content"><fieldset class="erphpdown-see">仅限注册用户</fieldset></div>'),
    AuthenticationRequiredError,
  );
});
