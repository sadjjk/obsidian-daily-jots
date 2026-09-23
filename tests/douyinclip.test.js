"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { douyinTitle, extractDouyin, isDouyinUrl, parseItem } = require("../src/clip/social-media/douyinclip");

const VIDEO_URL = "https://www.douyin.com/video/7685345478182997248";
const SHARE_URL = "https://www.iesdouyin.com/share/video/7685345478182997248/";

const ITEM = {
  aweme_id: "7685345478182997248",
  desc: "我去！大肥鱼的地基居然是源自一个写 QQ 机器人的人？！\n一个月二十二万星的框架。#抖音前沿科技首发计划 #AI新星计划",
  create_time: 1789383941,
  author: { nickname: "小放不开放" },
  statistics: { digg_count: 965, comment_count: 54, collect_count: 550, share_count: 141 },
  video: {
    cover: { url_list: ["https://p3.douyinpic.com/cover.jpg"] },
    play_addr: { uri: "v2800fgi0000dap9jqvog65s0srhev1g", url_list: ["https://www.douyin.com/aweme/v1/play/?video"] },
  },
};

const SHELL_HTML = `<html><head><title>抖音</title></head><body><script>
window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"ua":"iphone","itemId":"7685345478182997248"}}};
</script></body></html>`;

const DATA_HTML = `<html><body><script>
window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[${JSON.stringify(ITEM)}]}}}};
</script></body></html>`;

// detail API(2026-09 主路径)响应:JSON 结构与 item_list[0] 同族
const DETAIL_JSON = JSON.stringify({ status_code: 0, aweme_detail: ITEM });
const EMPTY_DETAIL_JSON = JSON.stringify({ status_code: 1105, aweme_detail: null });

// 与 safeFetch 真实契约一致:{ response, finalUrl };response.body 是显式属性
// (async-iterable),headers.get 对 set-cookie 返回 join 串。
function douyinResponse(html, setCookie = "") {
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "set-cookie" ? setCookie : null) },
      body: (async function* generateBody() {
        yield Buffer.from(html, "utf8");
      })(),
    },
    finalUrl: SHARE_URL,
  };
}

test("recognizes douyin video urls", () => {
  assert.equal(isDouyinUrl("https://v.douyin.com/jq6JF3Vyxi8/"), true);
  assert.equal(isDouyinUrl("https://www.douyin.com/video/7685345478182997248?previous_page=app_code_link"), true);
  assert.equal(isDouyinUrl("https://www.iesdouyin.com/share/video/7685345478182997248/"), true);
  assert.equal(isDouyinUrl("https://www.douyin.com/discover"), false);
  assert.equal(isDouyinUrl("https://weibo.com/anything"), false);
});

test("two-hop extraction seeds ttwid then fetches detail API with the ticket", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), cookie: options.headers?.cookie || "" });
    if (String(url).includes("/aweme/v1/web/aweme/detail/")) return douyinResponse(DETAIL_JSON);
    if (calls.length === 1) {
      return douyinResponse(SHELL_HTML, "ttwid=seeded-ticket; Path=/; Domain=.douyin.com, other=1");
    }
    return douyinResponse(DATA_HTML);
  };
  const data = await extractDouyin(VIDEO_URL, fetchImpl);
  assert.equal(calls.length, 2); // 落地页 + detail API(detail 成功后不再请求 share 页)
  assert.match(calls[1].url, /\/aweme\/v1\/web\/aweme\/detail\//);
  assert.match(calls[1].cookie, /^ttwid=seeded-ticket$/);
  assert.equal(data.title, "我去！大肥鱼的地基居然是源自一个写 QQ 机器人的人？！");
  assert.equal(data.byline, "小放不开放");
  assert.equal(data.extractionMethod, "douyin");
  assert.equal(data.identityUrl, "douyin-video:7685345478182997248");
  assert.equal(data.canonicalUrl, "https://www.douyin.com/video/7685345478182997248");
  assert.deepEqual(data.images, ["https://p3.douyinpic.com/cover.jpg"]);
  assert.match(data.contentHtml, /<h3 class="douyin-item-author">小放不开放<\/h3>/);
  assert.match(data.contentHtml, /赞 965 · 评论 54 · 收藏 550 · 转发 141/);
  assert.match(data.contentHtml, /#抖音前沿科技首发计划 #AI新星计划/);
  assert.doesNotMatch(data.contentHtml, /<a href="https:\/\/www\.douyin\.com\/search/);
  assert.match(data.contentHtml, /<img src="https:\/\/p3\.douyinpic\.com\/cover\.jpg"/);
  assert.match(data.contentHtml, /<a href="https:\/\/aweme\.snssdk\.com\/aweme\/v1\/playwm\/\?video_id=v2800fgi0000dap9jqvog65s0srhev1g&ratio=720p&line=0">视频<\/a>/);
});

test("single hop succeeds when the first response already carries data", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return douyinResponse(DATA_HTML);
  };
  const data = await extractDouyin(SHARE_URL, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(data.byline, "小放不开放");
});

test("missing visitor ticket raises a real error instead of saving a shell", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/aweme/v1/web/aweme/detail/")) return douyinResponse(EMPTY_DETAIL_JSON);
    return douyinResponse(SHELL_HTML);
  };
  await assert.rejects(extractDouyin(VIDEO_URL, fetchImpl), /did not issue a visitor ticket/);
  // 第一跳无票后:裸 share 页领票(2)→ detail API 尝试(3)→ 无票无数据才放弃。
  assert.equal(calls.length, 3);
});

test("seeds the ticket from the bare share page then uses it on the detail API", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), cookie: options.headers?.cookie || "" });
    if (String(url).includes("/aweme/v1/web/aweme/detail/")) return douyinResponse(DETAIL_JSON);
    if (calls.length === 1) return douyinResponse(SHELL_HTML); // 落地页缓存命中:无票
    return douyinResponse(SHELL_HTML, "ttwid=fresh-ticket"); // 裸页领票
  };
  const data = await extractDouyin(VIDEO_URL, fetchImpl);
  assert.equal(calls.length, 3); // 落地页 + 裸页领票 + detail API
  assert.match(calls[2].url, /\/aweme\/v1\/web\/aweme\/detail\//);
  assert.equal(calls[2].cookie, "ttwid=fresh-ticket");
  assert.equal(data.byline, "小放不开放");
});

test("parseItem falls back to any loaderData page carrying item_list", () => {
  const html = `<script>window._ROUTER_DATA = {"loaderData":{"video_(unknown)/page":{"item_list":[${JSON.stringify(ITEM)}]}}};</script>`;
  assert.equal(parseItem(html)?.aweme_id, "7685345478182997248");
  assert.equal(parseItem(SHELL_HTML), null);
  assert.equal(parseItem("<html>no router data</html>"), null);
});

test("douyinTitle strips hashtags and truncates long first lines", () => {
  assert.equal(douyinTitle("第一行标题\n第二行"), "第一行标题");
  assert.equal(douyinTitle("#话题一 内容主体 #话题二"), "内容主体");
  const long = "很".repeat(60);
  const title = douyinTitle(long);
  assert.equal(title.length, 41);
  assert.ok(title.endsWith("…"));
  assert.ok(title.startsWith("很".repeat(40)));
  assert.equal(douyinTitle(""), "抖音视频");
});
