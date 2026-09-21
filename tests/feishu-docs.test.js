"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFeishuDoc, normalizeFeishuPublishedTime, isFeishuFileUrl, extractFeishuFile, blockMapToMarkdown, feishuRichText } = require("../src/clip/cloud-docs/feishu-docs");
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
  assert.deepEqual(calls[0], ["https://my.feishu.cn/wiki/x", "feishu", { captureTimeoutMs: 42_000, extraEvaluate: calls[0][2].extraEvaluate }]);
  assert.match(calls[0][2].extraEvaluate, /_clientvarMap/);
  assert.deepEqual(calls[1], ["feishu", "https://my.feishu.cn/"]);
  assert.deepEqual(result.imageHeaders, { cookie: "feishu_session=tok" });
  assert.equal(result.author, "Alice");
  assert.equal(result.extractionMethod, "feishu-dom");
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
      return { json: async () => ({ data: { fileMeta: { name: "prompt_builder.py", version: "7639013533866314704", createTime: 1789996800000, owner: { name: "张三", userId: "ou_123" } } } }) };
    },
  });
  assert.equal(metaCalls[0].target, "https://my.feishu.cn/space/api/meta/?token=NOU6bPeNfoKwPbxZDPlcQ0InnL4&type=12&need_extra_fields=3");
  assert.equal(metaCalls[0].headers.cookie, cookie);
  assert.equal(file.streamUrl.includes("&version=7639013533866314704"), true);
  assert.equal(file.fallbackName, "prompt_builder.py");
  assert.equal(file.publishedAt, localIso(new Date(1789996800000)));
  assert.equal(file.author, "张三");
});

test("feishu file meta author falls back to flat owner name fields and skips ids", async () => {
  const payload = { data: { ownerId: "ou_abc", ownerName: "李四" } };
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => "session=tok",
    fetchImpl: async () => ({ json: async () => payload }),
  });
  assert.equal(file.author, "李四");
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

test("feishu file meta name matching degrades when the field is not exactly named", async () => {
  // 文件名字段叫 objName(不在精确清单)且无 version/createTime:name 降级命中,其余兜底
  const payload = JSON.stringify({ data: { objName: "prompt_builder.py", size: 1208, type: 12 } });
  const file = await extractFeishuFile("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4", {
    collectSessionCookies: async () => "session=tok",
    fetchImpl: async () => ({ json: async () => JSON.parse(payload) }),
  });
  assert.equal(file.fallbackName, "prompt_builder.py");
  assert.equal(file.streamUrl.includes("version="), false);
  assert.equal(file.publishedAt, "");
});

// C1: 内存块数据 → Markdown 转换 —— fixture 结构与实测 _clientvarMap 一致
// (block[id]={id,version,data:{type,children,text:{apool,initialAttributedTexts},language}})
function block(type, extra = {}) {
  return { data: { type, parent_id: "", comments: [], children: [], author: "u", ...extra } };
}
// 富文本:content 是纯串,attribs 是 etherpad changeset(*idx 引用 apool,+len36 段长)
function richText(content, attribs = "", pool = {}) {
  return { apool: { numToAttrib: pool }, initialAttributedTexts: { attribs: { "0": attribs }, text: { "0": content } } };
}
function clientvar(blockMap) {
  return JSON.stringify({ data: { block_map: blockMap } });
}

test("blockMapToMarkdown renders headings, lists, code, quote from the memory block map", () => {
  const raw = clientvar({
    root: block("page", { children: ["h1", "t1", "b1", "o1", "c1", "q1"] }),
    h1: block("heading1", { text: richText("标题一") }),
    t1: block("text", { text: richText("普通段落") }),
    b1: block("bullet", { text: richText("无序项") }),
    o1: block("ordered", { text: richText("有序项") }),
    c1: block("code", { language: "JavaScript", text: richText("const a = 1;\n") }),
    q1: block("quote", { text: richText("引用行") }),
  });
  const md = blockMapToMarkdown(raw);
  assert.match(md, /^## 标题一/m);
  assert.match(md, /^普通段落/m);
  assert.match(md, /^- 无序项/m);
  assert.match(md, /^1\. 有序项/m);
  assert.match(md, /```javascript\nconst a = 1;\n```/);
  assert.match(md, /^> 引用行/m);
});

test("feishuRichText applies bold and inlineCode from apool attribs", () => {
  // apool 0=bold 1=inlineCode;"粗体"(2字)加粗 + "码"(1字)行内代码 + 尾部普通
  // 段编码:*0+2 (前2字加粗) ; *1+1 (次1字行内码) ; +2 (末2字普通)
  const text = richText("粗体码尾巴", "*0+2*1+1+2", { 0: ["bold", "true"], 1: ["inlineCode", "true"] });
  assert.equal(feishuRichText(text), "**粗体**`码`尾巴");
});

test("blockMapToMarkdown emits a GFM table from cell_set block references", () => {
  const raw = clientvar({
    root: block("page", { children: ["tb"] }),
    tb: block("table", {
      columns_id: ["cA", "cB"],
      rows_id: ["r1", "r2"],
      cell_set: {
        r1cA: { block_id: "e1" }, r1cB: { block_id: "e2" },
        r2cA: { block_id: "e3" }, r2cB: { block_id: "e4" },
      },
    }),
    e1: block("table_cell", { children: ["te1"] }),
    e2: block("table_cell", { children: ["te2"] }),
    e3: block("table_cell", { children: ["te3"] }),
    e4: block("table_cell", { children: ["te4"] }),
    te1: block("text", { text: richText("H1") }),
    te2: block("text", { text: richText("H2") }),
    te3: block("text", { text: richText("v1") }),
    te4: block("text", { text: richText("v2") }),
  });
  const md = blockMapToMarkdown(raw);
  assert.match(md, /\| H1 \| H2 \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| v1 \| v2 \|/);
});

test("blockMapToMarkdown degrades unknown block types to their text and returns empty on missing root", () => {
  const raw = clientvar({
    root: block("page", { children: ["x1"] }),
    x1: block("mystery_widget", { text: richText("兜底文本") }),
  });
  assert.match(blockMapToMarkdown(raw), /兜底文本/);
  assert.equal(blockMapToMarkdown(clientvar({})), "");
  assert.equal(blockMapToMarkdown("not json"), "");
});

test("extractFeishuDoc prefers memory block map and labels feishu-block-map", async () => {
  const raw = clientvar({
    root: block("page", { children: ["h"] }),
    h: block("heading1", { text: richText("内存直取标题") }),
  });
  const result = await extractFeishuDoc("https://my.feishu.cn/docx/KsWjdmlguoa5WCxliKKcpTfXn8N", {
    webSessionManager: { extract: async (url, service, opts) => ({ html: "<main>渲染兜底</main>", url, title: "t", extraValue: raw }) },
    collectSessionCookies: async () => "feishu_session=tok",
  });
  assert.equal(result.extractionMethod, "feishu-block-map");
  assert.match(result.markdown, /## 内存直取标题/);
  assert.deepEqual(result.imageHeaders, { cookie: "feishu_session=tok" });
});

test("extractFeishuDoc falls back to feishu-dom when memory block map is empty", async () => {
  const result = await extractFeishuDoc("https://my.feishu.cn/docx/KsWjdmlguoa5WCxliKKcpTfXn8N", {
    webSessionManager: { extract: async (url) => ({ html: "<main>渲染正文</main>", url, extraValue: "" }) },
    collectSessionCookies: async () => "",
  });
  assert.equal(result.extractionMethod, "feishu-dom");
  assert.equal("markdown" in result, false);
});
