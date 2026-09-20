"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFeishuDoc } = require("../src/clip/cloud-docs/feishu-docs");
const { localIso } = require("../src/core/util");

test("extractFeishuDoc bridges the rendered session cookie into imageHeaders", async () => {
  const calls = [];
  const rendered = {
    html: "<main>飞书正文</main>",
    url: "https://my.feishu.cn/wiki/x",
    title: "t",
    author: "Alice",
    publishedTime: "2023年11月3日创建",
  };
  const result = await extractFeishuDoc("https://my.feishu.cn/wiki/x", {
    webSessionManager: { extract: async (...args) => { calls.push(args); return rendered; } },
    collectSessionCookies: async (service, origin) => { calls.push([service, origin]); return "feishu_session=tok"; },
    captureTimeoutMs: 42_000,
  });
  assert.deepEqual(calls[0], ["https://my.feishu.cn/wiki/x", "feishu", { captureTimeoutMs: 42_000 }]);
  assert.deepEqual(calls[1], ["feishu", "https://my.feishu.cn/"]);
  assert.deepEqual(result.imageHeaders, { cookie: "feishu_session=tok" });
  assert.equal(result.author, "Alice");
  assert.equal(result.publishedTime, localIso(new Date(2023, 10, 3)));
});

test("extractFeishuDoc keeps imageHeaders unset when no session cookie exists", async () => {
  const result = await extractFeishuDoc("https://my.feishu.cn/wiki/x", {
    webSessionManager: { extract: async () => ({ html: "<main>飞书正文</main>", url: "https://my.feishu.cn/wiki/x" }) },
    collectSessionCookies: async () => "",
  });
  assert.equal("imageHeaders" in result, false);
});

test("normalizeFeishuPublishedTime falls back to the raw copy when no date is present", () => {
  const { normalizeFeishuPublishedTime } = require("../src/clip/cloud-docs/feishu-docs");
  assert.equal(normalizeFeishuPublishedTime("刚刚更新"), "刚刚更新");
  assert.equal(normalizeFeishuPublishedTime("编辑于 2023年11月3日"), localIso(new Date(2023, 10, 3)));
  assert.equal(normalizeFeishuPublishedTime("2023-11-03 14:30"), localIso(new Date(2023, 10, 3, 14, 30)));
  assert.equal(normalizeFeishuPublishedTime(""), "");
});
