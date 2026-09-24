"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractZhihu,
  isZhihuNoteUrl,
  isZhihuUrl,
  parseInitialData,
  probeZhihuVideos,
  zhihuDataFromHtml,
} = require("../src/clip/social-media/zhihuclip");
const { localIso } = require("../src/core/util");

const ANSWER_URL = "https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373?share_code=KoQvmVk9iNoq";
const ARTICLE_URL = "https://zhuanlan.zhihu.com/p/1909282";

function answerStateHtml() {
  const state = {
    initialState: {
      entities: {
        users: { u1: { id: "u1", name: "张三" } },
        questions: { q1: { id: "q1", title: "如何优雅地抓取知乎回答?" } },
        answers: {
          a1: {
            id: "a1",
            question: "q1",
            author: "u1",
            content: `<p>先分析再动手。<br><img data-actualsrc="//pic1.zhimg.com/50/v2-abc.jpg" src="//pic1.zhimg.com/50/v2-abc.jpg"></p><p>${"关键是要带 cookie 才能通过知乎的风控。".repeat(6)}</p>`,
            createdTime: 1700000000,
            voteupCount: 1234,
          },
        },
      },
    },
  };
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html><head></head><body><script id="js-initialData" type="text/json">${json}</script></body></html>`;
}

function articleStateHtml() {
  const state = {
    initialState: {
      entities: {
        users: { u2: { id: "u2", name: "李四" } },
        articles: {
          p1: {
            id: "p1",
            title: "一篇知乎专栏文章",
            author: "u2",
            content: `<p>${"专栏正文内容,需要足够长以通过完整性判定。".repeat(6)}</p>`,
            created: 1690000000,
            voteupCount: 56,
          },
        },
      },
    },
  };
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html><head></head><body><script id="js-initialData" type="text/json">${json}</script></body></html>`;
}

function domFallbackHtml() {
  return `<!doctype html><html><head><meta name="author" content="王五"></head><body>
    <div class="QuestionHeader-title">DOM 回退的问题标题</div>
    <div class="RichContent-inner"><p>回答正文内容,这里需要有足够的文字来通过完整性判断,所以多写一点字数凑一凑长度要求。</p></div>
  </body></html>`;
}

function questionStateHtml() {
  const state = {
    initialState: {
      entities: {
        users: { u3: { id: "u3", name: "酱紫君" } },
        questions: {
          "1951716962645288920": {
            id: "1951716962645288920",
            title: "为什么我会感觉vibe coding让程序员越来越浮躁了?",
            detail: "<p>管理层:无脑吹AI提效,大力鼓励程序员vibe coding;底层牛马:能完成需求就行,中小型公司也没有code review的习惯。</p>",
            answerCount: 653,
            followerCount: 2946,
          },
        },
        answers: {
          a9: {
            id: "a9",
            author: "u3",
            content: `<p>${"Vibe Coding 让土老板越来越浮躁了,老板看多了营销文觉得你应该提升很多效率,做不到就认为你不够努力。".repeat(2)}</p>`,
            createdTime: 1789400000,
            voteupCount: 3385,
          },
        },
      },
    },
  };
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html><head></head><body><script id="js-initialData" type="text/json">${json}</script></body></html>`;
}

function fakeHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: (async function* () { yield Buffer.from(String(html || "")); })(),
  };
}

test("Zhihu URLs cover the whole site while note detection stays strict", () => {
  assert.equal(isZhihuUrl(ANSWER_URL), true);
  assert.equal(isZhihuUrl("https://zhuanlan.zhihu.com/p/1909282"), true);
  assert.equal(isZhihuUrl("https://example.com/question/1/answer/2"), false);
  assert.equal(isZhihuNoteUrl(ANSWER_URL), true);
  assert.equal(isZhihuNoteUrl(ARTICLE_URL), true);
  assert.equal(isZhihuNoteUrl("https://www.zhihu.com/people/someone"), false);
});

test("answer pages parse js-initialData into structured content with images and metadata", async () => {
  const data = await extractZhihu(ANSWER_URL, async (url) => ({
    response: fakeHtmlResponse(answerStateHtml()),
    finalUrl: url.split("?")[0],
  }));
  assert.equal(data.title, "如何优雅地抓取知乎回答?");
  assert.equal(data.byline, "张三");
  assert.equal(data.siteName, "知乎");
  assert.equal(data.extractionMethod, "zhihu-initial-state");
  assert.equal(data.publishedAt, localIso(new Date(1700000000000)));
  assert.equal(data.identityUrl, "https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373");
  assert.deepEqual(data.images, ["https://pic1.zhimg.com/50/v2-abc.jpg"]);
  assert.match(data.contentHtml, /先分析再动手/);
  assert.match(data.contentHtml, /1\.2K 赞同/);
  assert.doesNotMatch(data.contentHtml, /data-actualsrc/);
});

test("question pages parse the problem statement plus first-screen answers", () => {
  const data = zhihuDataFromHtml(questionStateHtml(), "https://www.zhihu.com/question/1951716962645288920");
  assert.ok(data);
  assert.equal(data.title, "为什么我会感觉vibe coding让程序员越来越浮躁了?");
  assert.equal(data.canonicalUrl, "https://www.zhihu.com/question/1951716962645288920");
  assert.equal(data.identityUrl, "https://www.zhihu.com/question/1951716962645288920");
  assert.equal(data.siteName, "知乎");
  assert.equal(data.extractionStatus, "complete");
  assert.match(data.contentHtml, /管理层/);
  assert.match(data.contentHtml, /653 个回答 · 2946 人关注/);
  assert.match(data.contentHtml, /酱紫君 · 3\.4K 赞同/);
  assert.match(data.contentHtml, /土老板/);
  assert.match(data.contentHtml, /共 653 个回答,已收录首屏 1 条/);
});

test("question URL counts as a clippable note for diagnostics", () => {
  assert.equal(isZhihuNoteUrl("https://www.zhihu.com/question/1951716962645288920"), true);
  assert.equal(isZhihuNoteUrl("https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373"), true);
  assert.equal(isZhihuNoteUrl("https://www.zhihu.com/people/someone"), false);
});

test("column articles parse their own initial-data entities", () => {
  const data = zhihuDataFromHtml(articleStateHtml(), ARTICLE_URL);
  assert.equal(data.title, "一篇知乎专栏文章");
  assert.equal(data.byline, "李四");
  assert.equal(data.siteName, "知乎专栏");
  assert.equal(data.publishedAt, localIso(new Date(1690000000000)));
});

test("pages without js-initialData fall back to question and answer DOM", async () => {
  const data = await extractZhihu(ANSWER_URL, async (url) => ({
    response: fakeHtmlResponse(domFallbackHtml()),
    finalUrl: url.split("?")[0],
  }));
  assert.equal(data.title, "DOM 回退的问题标题");
  assert.equal(data.byline, "王五");
  assert.equal(data.extractionMethod, "zhihu-dom");
  assert.match(data.plainText, /回答正文内容/);
});

test("cookie-gated 403 responses retry once through the cookie provider", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options);
    if (calls.length === 1) return { response: fakeHtmlResponse("", 403), finalUrl: url };
    return { response: fakeHtmlResponse(answerStateHtml()), finalUrl: url.split("?")[0] };
  };
  const data = await extractZhihu(ANSWER_URL, fetchImpl, async () => "d_c0=abc; z_c0=xyz");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.cookie, "d_c0=abc; z_c0=xyz");
  assert.equal(calls[1].headers.referer, "https://www.zhihu.com/");
  assert.equal(data.title, "如何优雅地抓取知乎回答?");
});

test("a 403 without cookies or provider surfaces a diagnostic error instead of null", async () => {
  await assert.rejects(
    extractZhihu(ANSWER_URL, async () => ({ response: fakeHtmlResponse("", 403), finalUrl: ANSWER_URL })),
    /Zhihu page returned HTTP 403/,
  );
  await assert.rejects(
    extractZhihu(ANSWER_URL, async () => ({ response: fakeHtmlResponse("<html><body>no data</body></html>"), finalUrl: ANSWER_URL }), async () => ""),
    /no note data/,
  );
});

test("parseInitialData tolerates missing or malformed payloads", () => {
  assert.equal(parseInitialData("<html><body>no scripts</body></html>"), null);
  assert.equal(parseInitialData('<script id="js-initialData" type="text/json">{broken</script>'), null);
  const state = parseInitialData('<script id="js-initialData" type="text/json">{"initialState":{"entities":{}}}</script>');
  assert.deepEqual(state, { initialState: { entities: {} } });
});

test("probeZhihuVideos extracts and dedupes vzuu mp4 links from rendered html", async () => {
  const html = 'player mounted: https://vdn3.vzuu.com/a.mp4?auth_key=x <video src="https://vdn3.vzuu.com/a.mp4?auth_key=x"> https://vd5.vzuu.com/b.mp4?auth_key=y';
  const calls = [];
  const sessionManager = {
    extract: async (url, service, options) => { calls.push([url, service, options]); return { html }; },
  };
  const urls = await probeZhihuVideos(ANSWER_URL, sessionManager, { collectSessionCookies: () => "" });
  assert.deepEqual(urls, ["https://vdn3.vzuu.com/a.mp4?auth_key=x", "https://vd5.vzuu.com/b.mp4?auth_key=y"]);
  // options 原样透传(函数不做引用比较)
  assert.equal(calls[0][0], ANSWER_URL);
  assert.equal(calls[0][1], "zhihu");
  assert.deepEqual(Object.keys(calls[0][2]), ["collectSessionCookies"]);
});

test("probeZhihuVideos caps at five and degrades on errors", async () => {
  const six = Array.from({ length: 6 }, (_, i) => `https://vd${i}.vzuu.com/v.mp4?auth_key=${i}`).join(" ");
  assert.equal((await probeZhihuVideos(ANSWER_URL, { extract: async () => ({ html: six }) })).length, 5);
  assert.deepEqual(await probeZhihuVideos(ANSWER_URL, { extract: async () => { throw new Error("timeout"); } }), []);
  assert.deepEqual(await probeZhihuVideos(ANSWER_URL, null), []);
  assert.deepEqual(await probeZhihuVideos(ANSWER_URL, { extract: async () => ({ html: "<video>no links</video>" }) }), []);
});
