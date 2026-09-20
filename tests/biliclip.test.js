"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractBilibili, formatCount, isBilibiliUrl, isBilibiliVideoUrl, jsonAssignmentFromHtml } = require("../src/clip/social-media/biliclip");
const { localIso } = require("../src/core/util");

const stateHtml = (videoDataJson) => `<!doctype html><html><head><title>x</title></head><body>
<script>window.__INITIAL_STATE__=${videoDataJson};(function(){var a={};})();</script>
<script>window.__pinia=window.__pinia||{};</script></body></html>`;

const fullState = {
  videoData: {
    bvid: "BV1Dve565ENK",
    title: "童年的捕鱼网,依然在我们的手里",
    desc: "每个人心底,都潜藏着名为\"好奇\"的本能。 请遵从内心的指引,用力掷出属于你的谜立方吧!",
    owner: { name: "伊莫官方" },
    pubdate: 1789457142,
    pic: "//i0.hdslb.com/bfs/archive/cover.jpg",
    stat: { view: 1214987, danmaku: 2021, like: 66749, coin: 30298, favorite: 52026, reply: 3456 },
  },
  tags: [{ tag_name: "伊莫上线定档" }, { tag_name: "游戏" }],
};

function fakeHtmlResponse(html, status = 200) {
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
      body: (async function* () { yield Buffer.from(String(html || "")); })(),
    },
    finalUrl: "https://www.bilibili.com/video/BV1Dve565ENK/",
  };
}

test("Bilibili URL helpers recognize video pages and short links", () => {
  assert.equal(isBilibiliUrl("https://www.bilibili.com/video/BV1Dve565ENK"), true);
  assert.equal(isBilibiliUrl("https://b23.tv/abc123"), true);
  assert.equal(isBilibiliUrl("https://www.zhihu.com/question/1"), false);
  assert.equal(isBilibiliVideoUrl("https://www.bilibili.com/video/BV1Dve565ENK/"), true);
  assert.equal(isBilibiliVideoUrl("https://www.bilibili.com/"), false);
  assert.equal(isBilibiliVideoUrl("https://b23.tv/abc123"), true);
});

test("the balanced JSON scanner handles braces inside strings and undefined literals", () => {
  const state = jsonAssignmentFromHtml(stateHtml('{"a":{"b":"brace } inside"},"c":undefined,"d":1}'), "window.__INITIAL_STATE__=");
  assert.deepEqual(state, { a: { b: "brace } inside" }, c: null, d: 1 });
  assert.equal(jsonAssignmentFromHtml("<html>no state here</html>", "window.__INITIAL_STATE__="), null);
});

test("counts format into the Chinese unit style", () => {
  assert.equal(formatCount(1214987), "121.5万");
  assert.equal(formatCount(2021), "2021");
  assert.equal(formatCount(234500000), "2.3亿");
});

test("Bilibili video pages extract structured metadata from the initial state", async () => {
  const clipper = await extractBilibili("https://www.bilibili.com/video/BV1Dve565ENK", async () => ({
    ...fakeHtmlResponse(stateHtml(JSON.stringify(fullState))),
  }));
  assert.equal(clipper.title, "童年的捕鱼网,依然在我们的手里");
  assert.equal(clipper.byline, "伊莫官方");
  assert.equal(clipper.extractionMethod, "bilibili-initial-state");
  assert.equal(clipper.extractionStatus, "complete");
  assert.match(clipper.markdown, /UP 主:伊莫官方/);
  assert.match(clipper.markdown, /播放 121\.5万 · 弹幕 2021 · 点赞 6\.7万/);
  assert.match(clipper.markdown, /伊莫上线定档 · 游戏/);
  assert.match(clipper.markdown, /谜立方/);
  assert.equal(clipper.publishedAt, localIso(new Date(1789457142 * 1000)));
  assert.deepEqual(clipper.images, ["https://i0.hdslb.com/bfs/archive/cover.jpg"]);
});

test("a challenge shell retries once and throws a real error instead of saving an empty note", async () => {
  let calls = 0;
  await assert.rejects(
    extractBilibili("https://www.bilibili.com/video/BV1Dve565ENK", async () => {
      calls += 1;
      return fakeHtmlResponse("<html><head><title>哔哩哔哩</title></head><body>verify</body></html>");
    }),
    /challenge page/,
  );
  // two web attempts + one public-API fallback
  assert.equal(calls, 3);
});

test("a shell on the first request recovers when the retry serves the full page", async () => {
  let calls = 0;
  const article = await extractBilibili("https://www.bilibili.com/video/BV1Dve565ENK", async () => {
    calls += 1;
    return calls === 1
      ? fakeHtmlResponse("<html><body>verify</body></html>")
      : fakeHtmlResponse(stateHtml(JSON.stringify(fullState)));
  });
  assert.equal(calls, 2);
  assert.equal(article.extractionMethod, "bilibili-initial-state");
});

test("persistent shells fall back to the public view API", async () => {
  let webCalls = 0;
  const article = await extractBilibili("https://www.bilibili.com/video/BV1Dve565ENK", async (url) => {
    if (/api\.bilibili\.com/.test(url)) {
      return {
        response: {
          ok: true, status: 200,
          headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
          body: (async function* () { yield Buffer.from(JSON.stringify({ code: 0, data: fullState.videoData })); })(),
        },
        finalUrl: url,
      };
    }
    webCalls += 1;
    return fakeHtmlResponse("<html><body>verify</body></html>");
  });
  assert.equal(webCalls, 2);
  assert.equal(article.extractionMethod, "bilibili-initial-state");
  assert.equal(article.title, "童年的捕鱼网,依然在我们的手里");
  assert.equal(article.byline, "伊莫官方");
});

test("non-video Bilibili pages fall through to the generic extractor", async () => {
  const article = await extractBilibili("https://www.bilibili.com/anime/", async () => {
    const redirect = fakeHtmlResponse("");
    redirect.finalUrl = "https://www.bilibili.com/anime/";
    return redirect;
  });
  assert.equal(article, null);
});
