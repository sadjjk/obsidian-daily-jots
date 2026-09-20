"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractXiaohongshu,
  isXiaohongshuUrl,
  isXhsNoteUrl,
  parseInitialState,
  replaceBareUndefined,
  xiaohongshuDataFromHtml,
} = require("../src/core/xhsclip");

const SOURCE_URL = "https://www.xiaohongshu.com/explore/note123?xsec_token=temporary";

function sampleHtml() {
  const state = `{"global":{"prompt":undefined},"note":{"currentNoteId":"note123","noteDetailMap":{"note123":{"note":{"noteId":"note123","title":"A useful note","desc":"First line\\nSecond line with enough useful text to save.","time":1788253336000,"user":{"nickname":"Alice"},"imageList":[{"urlPre":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fpreview-one","urlDefault":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fdefault-one","infoList":[{"imageScene":"WB_DFT","url":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fbest-one"}]},{"urlDefault":"https:\\u002F\\u002Fsns-webpic-hw.xhscdn.com\\u002Fsecond"},{"urlDefault":"https:\\u002F\\u002Ftracker.example.com\\u002Fpixel"}]}}}}}`;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${state}</script></body></html>`;
}

test("Xiaohongshu URLs include full and short share links", () => {
  assert.equal(isXiaohongshuUrl(SOURCE_URL), true);
  assert.equal(isXiaohongshuUrl("https://xhslink.com/a/AbCd12"), true);
  assert.equal(isXiaohongshuUrl("https://xhslink.cn/o/2Mh8nwXF6Xx"), true);
  assert.equal(isXiaohongshuUrl("https://example.com/explore/note123"), false);
});

test("initial-state JSON replaces only bare undefined values", () => {
  assert.equal(replaceBareUndefined('{"text":"undefined","value":undefined}'), '{"text":"undefined","value":null}');
  assert.equal(parseInitialState(sampleHtml()).global.prompt, null);
});

test("Xiaohongshu initial state yields full-size localizable images and stable identity", () => {
  const data = xiaohongshuDataFromHtml(sampleHtml(), SOURCE_URL);
  assert.equal(data.title, "A useful note");
  assert.equal(data.byline, "Alice");
  assert.equal(data.identityUrl, "https://www.xiaohongshu.com/explore/note123");
  assert.equal(data.extractionMethod, "xiaohongshu-initial-state");
  assert.deepEqual(data.images, [
    "https://sns-webpic-qc.xhscdn.com/best-one",
    "https://sns-webpic-hw.xhscdn.com/second",
  ]);
  assert.match(data.contentHtml, /小红书图片 1/);
  assert.match(data.contentHtml, /First line<br>Second line/);
});

test("note URLs cover share short links and note pages only", () => {
  assert.equal(isXhsNoteUrl("https://xhslink.cn/o/8MV5eiZ7OR9"), true);
  assert.equal(isXhsNoteUrl("https://xhslink.com/a/AbCd12"), true);
  assert.equal(isXhsNoteUrl("https://www.xiaohongshu.com/explore/note123?xsec_token=temporary"), true);
  assert.equal(isXhsNoteUrl("https://www.xiaohongshu.com/discovery/item/note123"), true);
  assert.equal(isXhsNoteUrl("https://www.xiaohongshu.com/user/profile/abc"), false);
  assert.equal(isXhsNoteUrl("https://example.com/explore/note123"), false);
});

function fakeHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: (async function* () { yield Buffer.from(String(html || "")); })(),
  };
}

test("note pages without note data fail with diagnostics instead of returning null", async () => {
  const challengeHtml = "<!doctype html><html><body>当前环境异常，完成验证后即可继续访问。</body></html>";
  await assert.rejects(
    extractXiaohongshu(SOURCE_URL, async () => ({
      response: fakeHtmlResponse(challengeHtml),
      finalUrl: SOURCE_URL,
    })),
    (error) => {
      assert.match(error.message, /no note data/);
      assert.match(error.message, /initial-state missing/);
      assert.match(error.message, /risk-control challenge detected/);
      return true;
    },
  );
});

test("transient risk-control statuses retry once with a referer before giving up", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      return {
        response: { ok: false, status: 461, headers: { get: () => null }, body: null },
        finalUrl: url,
      };
    }
    return { response: fakeHtmlResponse(sampleHtml()), finalUrl: SOURCE_URL };
  };
  const data = await extractXiaohongshu("https://xhslink.cn/o/8MV5eiZ7OR9", fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.referer, "https://www.xiaohongshu.com/");
  assert.equal(calls[0].headers["accept-language"], "zh-CN,zh;q=0.9");
  assert.equal(data.title, "A useful note");
});

test("non-note Xiaohongshu pages keep returning null when no note data exists", async () => {
  const data = await extractXiaohongshu("https://www.xiaohongshu.com/user/profile/abc", async (url) => ({
    response: fakeHtmlResponse("<!doctype html><html><body>profile</body></html>"),
    finalUrl: url,
  }));
  assert.equal(data, null);
});

function textlessHtml() {
  const state = `{"note":{"currentNoteId":"note999","noteDetailMap":{"note999":{"note":{"noteId":"note999","title":"","desc":"","time":1788253336000,"user":{"nickname":"Alice"},"imageList":[{"urlDefault":"https:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fone"},{"urlDefault":"https:\\u002F\\u002Fsns-webpic-hw.xhscdn.com\\u002Ftwo"}]}}}}}`;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${state}</script></body></html>`;
}

test("textless photo-only notes still extract with a fallback title and partial status", () => {
  const data = xiaohongshuDataFromHtml(textlessHtml(), "https://www.xiaohongshu.com/discovery/item/note999?xsec_token=temporary");
  assert.equal(data.title, "Alice 的图片笔记");
  assert.equal(data.byline, "Alice");
  assert.equal(data.extractionStatus, "complete");
  assert.equal(data.textless, true);
  assert.deepEqual(data.images, [
    "https://sns-webpic-qc.xhscdn.com/one",
    "https://sns-webpic-hw.xhscdn.com/two",
  ]);
  assert.match(data.contentHtml, /小红书图片 1/);
});
