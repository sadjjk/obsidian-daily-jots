"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractWeiboSearch, isWeiboSearchUrl, cleanWeiboText } = require("../src/core/weiboclip");

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
function weiboResponse(payload, ok = true, status = 200) {
  return {
    response: {
      ok, status,
      headers: { get: () => null },
      body: ok ? (async function* () { yield Buffer.from(JSON.stringify(payload)); })() : null,
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
  assert.match(data.contentHtml, /微博搜索 · 首屏 3 条/);
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
