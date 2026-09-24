"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractWeixinArticle, isWeixinArticleUrl } = require("../src/clip/social-media/weixinclip");

const ARTICLE_URL = "https://mp.weixin.qq.com/s/CKiM2G2CrqaBsR3qD0NKHw";

const FIXTURE_HTML = `<!doctype html><html><head><title>别把才华埋葬在昨天，换个接口抵达明日</title>
<meta property="og:title" content="别把才华埋葬在昨天，换个接口抵达明日" /></head><body>
<h1 id="activity-name">别把才华埋葬在昨天，换个接口抵达明日</h1>
<a id="js_name">架构师之路</a>
<div id="js_content">
<p>第一段:正文开头。<img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc123/640?wx_fmt=jpeg" src="data:image/svg+xml;base64,PHN2Zy8+" /></p>
<section><p>第二段:<img src="//mmbiz.qpic.cn/mmbiz_png/def456/640?wx_fmt=png" /></p></section>
</div>
<div class="cooldown_tips" style="display:none">环境异常</div>
</body></html>`;

function weixinResponse(html, status = 200) {
  return {
    response: {
      ok: status >= 200 && status < 300, status,
      headers: { get: () => "text/html" },
      body: (async function* () { yield Buffer.from(html); })(),
    },
    finalUrl: "",
  };
}

test("weixin article urls are recognized, other weixin pages are not", () => {
  assert.equal(isWeixinArticleUrl(ARTICLE_URL), true);
  assert.equal(isWeixinArticleUrl("https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=MzA3"), true);
  assert.equal(isWeixinArticleUrl("https://mp.weixin.qq.com/cgi-bin/appmsg?t=media"), false);
  assert.equal(isWeixinArticleUrl("https://weibo.com/ttarticle/p/show?id=1"), false);
});

test("weixin extraction promotes lazy images and reads og title", async () => {
  let sawHeaders;
  const fetchImpl = async (api, options) => { sawHeaders = options.headers; return weixinResponse(FIXTURE_HTML); };
  const data = await extractWeixinArticle(ARTICLE_URL, fetchImpl, async () => "wwr_seed=demo; pass_ticket=demo");
  assert.match(sawHeaders["user-agent"], /Chrome/);
  assert.equal(sawHeaders.cookie, "wwr_seed=demo; pass_ticket=demo");
  assert.equal(data.title, "别把才华埋葬在昨天，换个接口抵达明日");
  assert.equal(data.byline, "架构师之路");
  assert.equal(data.extractionMethod, "weixin");
  assert.match(data.contentHtml, /第一段:正文开头/);
  assert.match(data.contentHtml, /第二段:/);
  assert.doesNotMatch(data.contentHtml, /data:image\/svg/);
  assert.doesNotMatch(data.contentHtml, /data-src=/);
  assert.match(data.contentHtml, /src="https:\/\/mmbiz\.qpic\.cn\/mmbiz_jpg\/abc123\/640\?wx_fmt=jpeg"/);
  assert.match(data.contentHtml, /src="https:\/\/mmbiz\.qpic\.cn\/mmbiz_png\/def456\/640\?wx_fmt=png"/);
  assert.deepEqual(data.images, [
    "https://mmbiz.qpic.cn/mmbiz_jpg/abc123/640?wx_fmt=jpeg",
    "https://mmbiz.qpic.cn/mmbiz_png/def456/640?wx_fmt=png",
  ]);
  assert.equal(data.identityUrl, "weixin-article:CKiM2G2CrqaBsR3qD0NKHw");
});

test("weixin cooldown page and missing body fail with distinct messages", async () => {
  const cooldown = async () => weixinResponse('<html><body><div class="cooldown_tips">环境异常</div></body></html>');
  await assert.rejects(() => extractWeixinArticle(ARTICLE_URL, cooldown), /rate-limited/);
  const noBody = async () => weixinResponse('<html><head><title>t</title></head><body><div>other</div></body></html>');
  await assert.rejects(() => extractWeixinArticle(ARTICLE_URL, noBody), /rate-limited/);
});

test("degraded DOM still yields content via window.cgiDataNew.content_noencode", async () => {
  // 冷却形态:无 js_content 容器,但 cgiDataNew 数据完整(纯文本正文,\\xNN 转义)
  const degraded = `<html><head><title>t</title><meta property="og:title" content="别把才华埋葬在昨天，换个接口抵达明日" /></head><body>
<script>window.cgiDataNew = { content_noencode: '第一段:爱范儿收到感谢信。\\x0a\\x0a第二段:影响力看得不光是流量。\\x0a\\x0a第三段:<a href="https://mp.weixin.qq.com/s?__biz=1">明日产品 WATCHLIST</a>' };</script>
</body></html>`;
  const data = await extractWeixinArticle(ARTICLE_URL, async () => weixinResponse(degraded));
  assert.equal(data.title, "别把才华埋葬在昨天，换个接口抵达明日");
  assert.match(data.contentHtml, /<p>第一段:爱范儿收到感谢信。<\/p>/);
  assert.match(data.contentHtml, /<p>第二段:影响力看得不光是流量。<\/p>/);
  assert.match(data.contentHtml, /第三段:<a href="https:\/\/mp\.weixin\.qq\.com\/s\?__biz=1">明日产品 WATCHLIST<\/a>/);
  assert.deepEqual(data.images, []);
  assert.equal(data.extractionStatus, "complete");
});

test("rich-text fallback content promotes lazy images from content_noencode", async () => {
  const rich = `<html><head><title>t</title></head><body><script>window.cgiDataNew = { content_noencode: '<p>图文正文。<img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/x1/640?wx_fmt=jpeg" src="data:image/svg+xml;base64,PHN2Zy8+"></p>' };</script></body></html>`;
  const data = await extractWeixinArticle(ARTICLE_URL, async () => weixinResponse(rich));
  assert.match(data.contentHtml, /src="https:\/\/mmbiz\.qpic\.cn\/mmbiz_jpg\/x1\/640\?wx_fmt=jpeg"/);
  assert.doesNotMatch(data.contentHtml, /data:image\/svg/);
  assert.deepEqual(data.images, ["https://mmbiz.qpic.cn/mmbiz_jpg/x1/640?wx_fmt=jpeg"]);
});

test("card shell page yields nick_name, create_time and cdn_url cover", async () => {
  // 非微信环境返回的分享卡片壳(window.cgiDataNew):公众号名/发布时间/封面都在,js_content 不存在。
  // 防爬形态:数值写成 '0' * 1 表达式,换行是 \x0a 转义。
  const card = `<html><head><title>虚无的一体两面</title><meta property="og:title" content="虚无的一体两面，既然一切都没有意义，那我不如就此放弃 和 既然一切都没有意义，那我便随心所欲" /></head><body>
<script>window.cgiDataNew = {
  base_resp: { ret: '0' * 1, errmsg: 'ok' },
  user_name: 'gh_463a52c7ed51',
  nick_name: '风控建模',
  title: '虚无的一体两面，既然一切都没有意义，那我不如就此放弃 和 既然一切都没有意义，那我便随心所欲',
  content_noencode: '虚无的一体两面，既然一切都没有意义，那我不如就此放弃 和 既然一切都没有意义，那我便随心所欲。\\x0a\\x0a这大概就是消极的虚无主义和积极的虚无主义吧。',
  create_time: '2026-09-19 00:19',
  cdn_url: 'http://mmbiz.qpic.cn/sz_mmbiz_jpg/cover123/0?wx_fmt=jpeg',
  link: 'https://mp.weixin.qq.com/s/tqXwXxWF4SS9yh1bjPnKeQ',
  author: '',
  type: '9' * 1
};</script>
</body></html>`;
  const data = await extractWeixinArticle(ARTICLE_URL, async () => weixinResponse(card));
  assert.equal(data.byline, "风控建模");                              // nick_name 替代笼统的"微信公众号"
  assert.equal(data.publishedAt, "2026-09-19T00:19:00.000+08:00"); // create_time 字符串日期
  assert.deepEqual(data.images, ["https://mmbiz.qpic.cn/sz_mmbiz_jpg/cover123/0?wx_fmt=jpeg"]); // 封面,http 已升级 https
  assert.match(data.contentHtml, /<p class="weixin-card-cover"><img src="https:\/\/mmbiz\.qpic\.cn\/sz_mmbiz_jpg\/cover123\/0\?wx_fmt=jpeg" alt="封面" \/><\/p>/); // 封面前置进正文,本地化后 md 才有引用
  assert.match(data.contentHtml, /消极的虚无主义和积极的虚无主义/);
  assert.equal(data.extractionMethod, "weixin");
  assert.equal(data.extractionStatus, "complete");
});

test("album posts recover every picture from picture_page_info_list", async () => {
  // 图集帖(如「9张图讲清」):js_content 缺失,content_noencode 只有文字,图片全在 picture_page_info_list。
  // cdn_url 值带 \x26amp; 转义与 http 形态;数组外的 watermark_info.cdn_url 不属于图集,不得混入。
  const album = `<html><head><title>闲鱼卖100元的AI视频神器</title></head><body>
<script>window.cgiDataNew = {
  nick_name: 'AI软件设计师',
  create_time: '2026-09-24 11:00',
  cdn_url: 'https://mmbiz.qpic.cn/mmbiz_jpg/cover123/0?wx_fmt=jpeg',
  content_noencode: '这9张图讲清:它到底能复刻什么、安装命令和版权风险。',
  picture_page_info_list: [
    { cdn_url: 'https://mmbiz.qpic.cn/mmbiz_png/pic01/0?wx_fmt=png\\x26amp;from=appmsg', width: '1080' * 1, height: '1440' * 1 },
    { cdn_url: 'http://mmbiz.qpic.cn/sz_mmbiz_png/pic02/0?wx_fmt=png\\x26amp;from=appmsg', width: '1080' * 1, height: '1440' * 1 },
    { cdn_url: 'https://mmbiz.qpic.cn/mmbiz_png/pic01/0?wx_fmt=png\\x26amp;from=appmsg', width: '1080' * 1, height: '1440' * 1 }
  ],
  watermark_info: { cdn_url: 'http://mmbiz.qpic.cn/sz_mmbiz_png/watermark/0' },
  type: '25' * 1
};</script>
</body></html>`;
  const data = await extractWeixinArticle(ARTICLE_URL, async () => weixinResponse(album));
  // 图集图全部拼进正文(去重、http 升级 https、\x26amp; 还原),本地化管线才能下载并重写 md 引用
  assert.match(data.contentHtml, /<p><img src="https:\/\/mmbiz\.qpic\.cn\/mmbiz_png\/pic01\/0\?wx_fmt=png&from=appmsg" alt="图集-1" \/><\/p>/);
  assert.match(data.contentHtml, /<p><img src="https:\/\/mmbiz\.qpic\.cn\/sz_mmbiz_png\/pic02\/0\?wx_fmt=png&from=appmsg" alt="图集-2" \/><\/p>/);
  assert.match(data.contentHtml, /这9张图讲清/);
  assert.doesNotMatch(data.contentHtml, /watermark/);
  // images 返回与正文一致:封面 + 去重后的图集图
  assert.deepEqual(data.images, [
    "https://mmbiz.qpic.cn/mmbiz_jpg/cover123/0?wx_fmt=jpeg",
    "https://mmbiz.qpic.cn/mmbiz_png/pic01/0?wx_fmt=png&from=appmsg",
    "https://mmbiz.qpic.cn/sz_mmbiz_png/pic02/0?wx_fmt=png&from=appmsg",
  ]);
});
