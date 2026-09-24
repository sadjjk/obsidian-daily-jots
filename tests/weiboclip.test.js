"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractWeibo, extractWeiboArticle, extractWeiboSearch, extractWeiboStatus, isWeiboArticleUrl, isWeiboSearchUrl, isWeiboStatusUrl, cleanWeiboText, weiboStatusId } = require("../src/clip/social-media/weiboclip");

const SEARCH_URL = "https://m.weibo.cn/search?containerid=231522type%3D1%26q%3D%23%E5%8D%97%E6%96%B9%E5%8C%BB%E7%A7%91%E5%A4%A7%E5%AD%A6%E5%AD%A6%E7%94%9F%E5%8F%91%E5%A3%B0%23&v_p=42";

const FIXTURE = {
  ok: 1,
  data: {
    cards: [
      {
        mblog: {
          id: "5343777000262403",
          user: { screen_name: "大河报" },
          created_at: "Wed Sep 16 14:13:02 +0800 2026",
          text: '【<a href="//m.weibo.cn/search?q=%23南医大%23">#南方医科大学学生发声#</a>】近日,一名学生坠亡引发关注。<a href="//m.weibo.cn/n/%E5%A4%A7%E6%B2%B3%E6%8A%A5">@大河报</a> 记者致电未获回应。<a href="//m.weibo.cn/status/5343777000262403">全文</a><span class="url-icon"><img src="//h5.sinaimg.cn/icon.gif" alt="[心]" /></span>',
          reposts_count: 100,
          comments_count: 273,
          attitudes_count: 6655,
          pics: [{ large: { url: "https://wx1.sinaimg.cn/large/abc1.jpg" } }, { url: "https://wx1.sinaimg.cn/small/abc2.jpg" }],
        },
      },
      {
        card_group: [
          {
            mblog: {
              id: "5343790803714306",
              user: { screen_name: "潇湘晨报" },
              created_at: "Wed Sep 16 14:05:58 +0800 2026",
              text: "#南方医科大学已成立专项工作组# 同学发声:师兄当晚未回宿舍",
              reposts_count: 454,
              comments_count: 512,
              attitudes_count: 0,
              retweeted_status: { user: { screen_name: "当事人" }, text: "原始表述" },
            },
          },
          {
            mblog: {
              id: "5343799900000000",
              user: { screen_name: "路人" },
              created_at: "bad-date",
              text: '第三条 <a href="//video.weibo.com/show?fid=1034:534373"><img src="//h5.sinaimg.cn/upload/2015/09/25/3/timeline_card_small_video_default.png"> 路人的微博视频</a>',
              page_info: { type: "video", page_url: "https://video.weibo.com/show?fid=1034:534373" },
            },
          },
        ],
      },
      { card_type: 11 },
    ],
  },
};

const SUB_COOKIE = "SUBP=xxx; SUB=_2AkTestCookieValue; XSRF-TOKEN=985607";
// 与 safeFetch 的真实契约一致:{ response, finalUrl },response 是自定义对象
// (headers.get + async-iterable body,无标准 .json(),须用 readLimitedBody 读)。
function weiboResponse(payload, ok = true, status = 200, contentType = "application/json") {
  return {
    response: {
      ok, status,
      headers: { get: () => contentType },
      body: ok ? (async function* () { yield Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)); })() : null,
    },
    finalUrl: "",
  };
}
const OK_FETCH = async () => weiboResponse(FIXTURE);
const RISK_FETCH = async () => weiboResponse(null, false, 432);
const OK0_FETCH = async () => weiboResponse({ ok: 0 });
const COOKIE_GETTER = async () => SUB_COOKIE;
const EMPTY_COOKIE_GETTER = async () => "";

test("weibo search urls are recognized", () => {
  assert.equal(isWeiboSearchUrl(SEARCH_URL), true);
  assert.equal(isWeiboSearchUrl("https://m.weibo.cn/status/5123456789012345"), false);
  assert.equal(isWeiboSearchUrl("https://weibo.com/u/123/home"), false);
});

test("url-icon spans (emoji icons) are stripped from mblog text", () => {
  const html = cleanWeiboText(FIXTURE.data.cards[0].mblog).html;
  assert.doesNotMatch(html, /url-icon/);
  assert.match(html, /#南方医科大学学生发声#/);
});

test("weibo search extraction renders mblogs into a structured article", async () => {
  const data = await extractWeiboSearch(SEARCH_URL, OK_FETCH, COOKIE_GETTER);
  assert.equal(data.extractionMethod, "weibo-json");
  assert.match(data.title, /南方医科大学学生发声/);
  assert.match(data.contentHtml, /#南方医科大学学生发声# 微博搜索 · 首屏 3 条/);
  // 双重标题消除:正文不再携带 h1
  assert.doesNotMatch(data.contentHtml, /<h1/);
  // 作者进大纲级 h3,meta 行带干净的"原文"链接
  assert.match(data.contentHtml, /<h3 class="weibo-item-author">大河报<\/h3>/);
  assert.match(data.contentHtml, /2026-09-16 14:13 · 转发 100 · 评论 273 · 赞 6655 · <a href="https:\/\/m\.weibo\.cn\/status\/5343777000262403">原文<\/a>/);
  // 话题/@/全文/视频链接全部降噪为纯文字或剥出
  assert.doesNotMatch(data.contentHtml, /m\.weibo\.cn\/search[^"]*">/);
  assert.doesNotMatch(data.contentHtml, /m\.weibo\.cn\/n\//);
  assert.doesNotMatch(data.contentHtml, />全文<\/a>/);
  assert.doesNotMatch(data.contentHtml, /url-icon/);
  assert.match(data.contentHtml, /#南方医科大学学生发声#】近日/);
  assert.match(data.contentHtml, /<img src="https:\/\/wx1\.sinaimg\.cn\/large\/abc1\.jpg"/);
  assert.match(data.contentHtml, /@当事人:原始表述/);
  assert.match(data.contentHtml, /<h3 class="weibo-item-author">潇湘晨报<\/h3>/);
  assert.match(data.contentHtml, /2026-09-16 14:05 · 转发 454 · 评论 512 · <a href="https:\/\/m\.weibo\.cn\/status\/5343790803714306">原文<\/a>/);
  assert.doesNotMatch(data.contentHtml, /赞 0/);
  // 视频占位卡片剥掉,meta 行给"视频"链接
  assert.match(data.contentHtml, /<h3 class="weibo-item-author">路人<\/h3>/);
  assert.match(data.contentHtml, /<a href="https:\/\/video\.weibo\.com\/show\?fid=1034:534373">视频<\/a>/);
  assert.doesNotMatch(data.contentHtml, /timeline_card_small_video/);
  assert.doesNotMatch(data.contentHtml, /第三条 <a /);
  assert.match(data.contentHtml, /第三条/);
  assert.deepEqual(data.images, ["https://wx1.sinaimg.cn/large/abc1.jpg", "https://wx1.sinaimg.cn/small/abc2.jpg"]);
});

test("weibo search requests carry only the SUB cookie", async () => {
  let seen;
  const fetchImpl = async (api, options) => {
    seen = { api, options };
    return weiboResponse(FIXTURE);
  };
  await extractWeiboSearch(SEARCH_URL, fetchImpl, COOKIE_GETTER);
  assert.match(seen.api, /api\/container\/getIndex\?containerid=231522type%3D1%26q%3D%23/);
  assert.match(seen.api, /page_type=searchall/);
  assert.equal(seen.options.headers.cookie, "SUB=_2AkTestCookieValue");
  assert.match(seen.options.headers["user-agent"], /iPhone/);
});

test("missing SUB cookie fails with an actionable error", async () => {
  await assert.rejects(
    () => extractWeiboSearch(SEARCH_URL, OK_FETCH, EMPTY_COOKIE_GETTER),
    /visitor cookie \(SUB\)/,
  );
});

test("HTTP 432 and ok:0 both report risk control instead of empty content", async () => {
  await assert.rejects(() => extractWeiboSearch(SEARCH_URL, RISK_FETCH, COOKIE_GETTER), /HTTP 432/);
  await assert.rejects(() => extractWeiboSearch(SEARCH_URL, OK0_FETCH, COOKIE_GETTER), /ok=0/);
});

const STATUS_URL = "https://m.weibo.cn/status/5343749552473518";
const STATUS_FIXTURE = {
  visible: { type: 0 },
  id: 5343749552473518,
  idstr: "5343749552473518",
  created_at: "Wed Sep 16 12:23:58 +0800 2026",
  text: '#南方医科大学跳楼##南方医科大学工作人员回应# 没人觉得这些硕导博导权力太大了吗?<a href="//m.weibo.cn/search?q=%23跳楼%23">#南方医科大学跳楼#</a>',
  user: { screen_name: "王者荣耀排行榜" },
  reposts_count: 67,
  comments_count: 87,
  attitudes_count: 2114,
  pics: [{ large: { url: "https://wx1.sinaimg.cn/large/status1.jpg" } }],
};
const STATUS_FETCH = async () => weiboResponse(STATUS_FIXTURE);
const SHOW_REJECT_FETCH = async () => weiboResponse({ ok: 0, msg: "微博不存在" });

test("weibo status urls are recognized and dispatched", async () => {
  assert.equal(isWeiboStatusUrl(STATUS_URL), true);
  assert.equal(isWeiboStatusUrl(SEARCH_URL), false);
  let usedApi = "";
  const fetchImpl = async (api) => { usedApi = api; return weiboResponse(STATUS_FIXTURE); };
  const data = await extractWeibo(STATUS_URL, fetchImpl, COOKIE_GETTER);
  assert.match(usedApi, /api\/statuses\/show\?id=5343749552473518/);
  assert.equal(data.title, "@王者荣耀排行榜 微博 2026-09-16");
  assert.match(data.contentHtml, /<h3 class="weibo-item-author">王者荣耀排行榜<\/h3>/);
  assert.match(data.contentHtml, /赞 2114 · <a href="https:\/\/m\.weibo\.cn\/status\/5343749552473518">原文<\/a>/);
  assert.match(data.contentHtml, /#南方医科大学跳楼##南方医科大学工作人员回应# 没人觉得/);
  assert.doesNotMatch(data.contentHtml, /<a [^>]*search/);
  assert.deepEqual(data.images, ["https://wx1.sinaimg.cn/large/status1.jpg"]);
  assert.equal(data.identityUrl, "weibo-status:5343749552473518");
});

test("weibo status API rejections report the server message", async () => {
  await assert.rejects(
    () => extractWeiboStatus(STATUS_URL, SHOW_REJECT_FETCH, COOKIE_GETTER),
    /微博不存在/,
  );
  await assert.rejects(
    () => extractWeiboStatus(STATUS_URL, RISK_FETCH, COOKIE_GETTER),
    /HTTP 432/,
  );
});

const ARTICLE_URL = `https://weibo.com/ttarticle/p/show?id=2309405343762020171911&luicode=10000011`;
const ARTICLE_HTML = `<!doctype html><html><head><title>孙子非亲生案代理律师:此案最大难点是孩子母亲拒绝亲子鉴定</title></head><body>
<div class="WB_editor_iframe_new"><p>第一段:案件的核心争议点。</p><p>第二段:<img src="//wx1.sinaimg.cn/large/art1.jpg">后续进展。</p></div>
<div class="card"><a href="//weibo.com/u/1734530730">大河报</a>简介</div></body></html>`;
const ARTICLE_FETCH = async () => ({ response: { ok: true, status: 200, headers: { get: () => "text/html" }, body: (async function* () { yield Buffer.from(ARTICLE_HTML); })() }, finalUrl: "" });

test("weibo ttarticle urls are recognized and dispatched without cookie", async () => {
  assert.equal(isWeiboArticleUrl(ARTICLE_URL), true);
  assert.equal(isWeiboArticleUrl(SEARCH_URL), false);
  let sawCookie;
  const fetchImpl = async (api, options) => { sawCookie = options.headers.cookie; return weiboResponse(ARTICLE_HTML, true, 200, "text/html"); };
  const data = await extractWeibo(ARTICLE_URL, fetchImpl, async () => "");
  assert.ok(!sawCookie, "ttarticle is anonymously readable: no cookie header expected");
  assert.equal(data.title, "孙子非亲生案代理律师:此案最大难点是孩子母亲拒绝亲子鉴定");
  assert.equal(data.extractionMethod, "ttarticle");
  assert.match(data.contentHtml, /第一段:案件的核心争议点/);
  assert.match(data.contentHtml, /后续进展/);
  assert.doesNotMatch(data.contentHtml, /大河报/);
  assert.deepEqual(data.images, ["https://wx1.sinaimg.cn/large/art1.jpg"]);
  assert.equal(data.identityUrl, "weibo-ttarticle:2309405343762020171911");
});

test("weibo ttarticle with a missing body container fails loudly", async () => {
  const noContainer = async () => weiboResponse("<html><head><title>t</title></head><body><div>other</div></body></html>", true, 200, "text/html");
  await assert.rejects(
    () => extractWeiboArticle(ARTICLE_URL, noContainer, COOKIE_GETTER),
    /body container was not found/,
  );
});

test("unencoded containerid (&q= split into its own param) is reassembled", async () => {
  const rawUrl = "https://m.weibo.cn/search?containerid=231522type=1&q=#野人先生创始人回应太贵#&_T_WM=47843839089&v_p=42";
  let seenApi = "";
  const fetchImpl = async (api) => { seenApi = api; return weiboResponse(FIXTURE); };
  const data = await extractWeiboSearch(rawUrl, fetchImpl, COOKIE_GETTER);
  // 重组后的接口请求必须带完整编码的 q,与标准形态逐字节一致
  assert.match(seenApi, /containerid=231522type%3D1%26q%3D%23%E9%87%8E%E4%BA%BA%E5%85%88%E7%94%9F%E5%88%9B%E5%A7%8B%E4%BA%BA%E5%9B%9E%E5%BA%94%E5%A4%AA%E8%B4%B5%23&page_type=searchall/);
  assert.equal(data.title, "#野人先生创始人回应太贵# 微博搜索");
  // 标准形态(已编码)不受影响
  let standardApi = "";
  const standardFetch = async (api) => { standardApi = api; return weiboResponse(FIXTURE); };
  await extractWeiboSearch(SEARCH_URL, standardFetch, COOKIE_GETTER);
  assert.match(standardApi, /containerid=231522type%3D1%26q%3D%23/);
});

test("weibo status extraction collects CDN direct links from the main post and retweet", async () => {
  const fixture = {
    ok: 1,
    id: "5346544981377322",
    user: { screen_name: "测试用户" },
    created_at: "Wed Sep 16 14:13:02 +0800 2026",
    text: "主贴视频",
    page_info: {
      type: "video",
      page_url: "https://video.weibo.com/show?fid=1034:1",
      urls: {
        mp4_720p_mp4: "//f.video.weibocdn.com/720p.mp4?Expires=1",
        mp4_hd_mp4: "//f.video.weibocdn.com/hd.mp4?Expires=1",
      },
      media_info: { stream_url: "https://f.video.weibocdn.com/stream.mp4" },
    },
    retweeted_status: {
      user: { screen_name: "原主" },
      text: "转发体视频",
      page_info: {
        type: "video",
        page_url: "https://video.weibo.com/show?fid=1034:2",
        urls: { mp4_hd_mp4: "//f.video.weibocdn.com/rt-hd.mp4" },
      },
    },
  };
  const data = await extractWeiboStatus(STATUS_URL, async () => weiboResponse(fixture), COOKIE_GETTER);
  // 每视频卡选优 1 个(hd 480p 优先):同视频多清晰度不重复保存;主贴+转发体各 1 个
  assert.deepEqual(data.videoUrls, [
    "https://f.video.weibocdn.com/hd.mp4?Expires=1",
    "https://f.video.weibocdn.com/rt-hd.mp4",
  ]);
});

test("weibo status without video page_info yields empty videoUrls", async () => {
  const fixture = {
    ok: 1,
    id: "5346544981377323",
    user: { screen_name: "测试用户" },
    created_at: "Wed Sep 16 14:13:02 +0800 2026",
    text: "纯文字微博",
  };
  const data = await extractWeiboStatus(STATUS_URL, async () => weiboResponse(fixture), COOKIE_GETTER);
  assert.deepEqual(data.videoUrls, []);
});

test("m.weibo.cn share links with /detail/<id> resolve to the same status id", () => {
  assert.equal(weiboStatusId("https://m.weibo.cn/detail/5346544981377322"), "5346544981377322");
  assert.equal(isWeiboStatusUrl("https://m.weibo.cn/detail/5346544981377322"), true);
  assert.equal(weiboStatusId("https://m.weibo.cn/status/5346544981377322"), "5346544981377322");
  assert.equal(isWeiboStatusUrl("https://visitor.passport.weibo.cn/visitor/visitor?a=enter"), false);
});

test("weibo status extraction collects direct links from url_objects video cards (page_info absent)", async () => {
  const fixture = {
    ok: 1,
    id: "5346544981377322",
    idstr: "5346544981377322",
    user: { screen_name: "央视新闻" },
    created_at: "Thu Sep 24 05:32:00 +0800 2026",
    text: "正文没有 page_info,视频卡在 url_objects",
    url_objects: [
      {
        url_ori: "http://t.cn/AXOk70mA",
        object: {
          object_type: "video",
          object: {
            object_type: "video",
            video_cover: "002TLsr9ly1ihebbg6cypj61hc0u041802",
            urls: {
              mp4_720p_mp4: "http://f.video.weibocdn.com/o0/720p.mp4?Expires=1&ssig=B",
              mp4_hd_mp4: "http://f.video.weibocdn.com/o0/hd.mp4?Expires=1&ssig=A",
            },
            stream: { url: "http://f.video.weibocdn.com/o0/hd.mp4?Expires=1&ssig=A", hd_url: "http://f.video.weibocdn.com/o0/hd.mp4?Expires=1&ssig=A" },
          },
        },
      },
      { url_ori: "http://t.cn/other", object: { object_type: "webpage", object: { object_type: "webpage" } } },
    ],
  };
  const data = await extractWeiboStatus("https://m.weibo.cn/detail/5346544981377322", async () => weiboResponse(fixture), COOKIE_GETTER);
  // 选优 1 个:480p 优先(hd);stream.url 与 hd 相同不追加;非视频卡跳过
  assert.deepEqual(data.videoUrls, ["http://f.video.weibocdn.com/o0/hd.mp4?Expires=1&ssig=A"]);
  // published_at 元数据补齐(API return 此前漏传 created_at)
  assert.match(String(data.publishedAt), /^2026-09-24/);
});
