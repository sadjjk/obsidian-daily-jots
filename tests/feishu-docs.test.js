"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFeishuDoc, normalizeFeishuPublishedTime, isFeishuFileUrl, extractFeishuFile } = require("../src/clip/cloud-docs/feishu-docs");
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
  // 飞书当年日期省略年份:"5月19日修改" → 当前年 5 月 19 日
  assert.equal(
    normalizeFeishuPublishedTime("5月19日修改"),
    localIso(new Date(new Date().getFullYear(), 4, 19)),
  );
  assert.equal(normalizeFeishuPublishedTime(""), "");
});

test("feishu file links resolve a version-less stream URL with session headers", async () => {
  assert.equal(isFeishuFileUrl("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4"), true);
  assert.equal(isFeishuFileUrl("https://my.feishu.cn/wiki/CEFJwoogJiIRG7kUISbc6JctnJg"), false);
  const cookie = "session=tok; _csrf_token=csrf-value-123; lang=zh";
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => cookie,
  });
  assert.equal(file.streamUrl, "https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/NOU6bPeNfoKwPbxZDPlcQ0InnL4?mount_point=explorer&preview_type=16");
  assert.equal(file.headers.cookie, cookie);
  assert.equal(file.headers["x-csrftoken"], "csrf-value-123");
  assert.equal(file.headers["x-command"], "stream.download.preview");
  assert.equal(file.headers["x-lgw-app-id"], "1161");
  assert.equal(file.fallbackName, "NOU6bPeNfoKwPbxZDPlcQ0InnL4");
  await assert.rejects(
    extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", { collectSessionCookies: async () => "" }),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED",
  );
});

test("feishu file meta enriches the stream URL with version, real name, and created time", async () => {
  const cookie = "session=tok; _csrf_token=csrf-value-123";
  const metaCalls = [];
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => cookie,
    fetchImpl: async (target, init) => {
      metaCalls.push({ target, headers: init.headers });
      return { json: async () => ({ data: { fileMeta: { name: "prompt_builder.py", version: "7639013533866314704", createTime: 1789996800000 } } }) };
    },
  });
  assert.equal(metaCalls[0].target, "https://my.feishu.cn/space/api/meta/?token=NOU6bPeNfoKwPbxZDPlcQ0InnL4&type=12&need_extra_fields=3");
  assert.equal(metaCalls[0].headers.cookie, cookie);
  assert.equal(file.streamUrl.includes("&version=7639013533866314704"), true);
  assert.equal(file.fallbackName, "prompt_builder.py");
  assert.equal(file.publishedAt, localIso(new Date(1789996800000)));
});

test("feishu file meta failure degrades to the version-less token fallback", async () => {
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => "session=tok",
    fetchImpl: async () => { throw new Error("meta down"); },
  });
  assert.equal(file.streamUrl.includes("version="), false);
  assert.equal(file.fallbackName, "NOU6bPeNfoKwPbxZDPlcQ0InnL4");
  assert.equal(file.publishedAt, "");
});

test("feishu file meta parses the safeFetch body-only response shape", async () => {
  const payload = JSON.stringify({ data: { fileMeta: { name: "报告.md", version: "42", createTime: 1789996800000 } } });
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => "session=tok",
    fetchImpl: async () => ({
      // safeFetch 形态:无 text/json,仅 body async generator
      headers: { get: () => "application/json" },
      body: (async function* () { yield Buffer.from(payload); })(),
    }),
  });
  // 短数字 version(42)不是流雪花 ID,不采纳 → 走无 version 直试
  assert.equal(file.fallbackName, "报告.md");
  assert.equal(file.streamUrl.includes("version="), false);
  assert.equal(file.publishedAt, localIso(new Date(1789996800000)));
});

test("feishu file meta keeps long snowflake versions and exposes a version-less fallback URL", async () => {
  const payload = JSON.stringify({ data: { fileMeta: { name: "设计稿.pdf", version: "7639013533866314704" } } });
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => "session=tok",
    fetchImpl: async () => ({ json: async () => JSON.parse(payload) }),
  });
  assert.equal(file.streamUrl.includes("&version=7639013533866314704"), true);
  assert.equal(file.fallbackStreamUrl.includes("version="), false);
  assert.equal(file.fallbackName, "设计稿.pdf");
});
