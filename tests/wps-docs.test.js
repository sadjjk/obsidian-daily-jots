"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractWpsDoc, otlToMarkdown, otlTitle, wpsDocToken, applyMarks } = require("../src/clip/cloud-docs/wps-docs");

// 实测 OTL 结构:content(根)>logic_block>block_tile>(outline-title|paragraph|heading|picture)
// text 节点 {text, marks?};heading.attrs.level;emoji.attrs.emoji;picture.attrs.sourceKey
function textNode(text, marks) { return marks ? { type: "text", text, marks } : { type: "text", text }; }
function para(children, attrs = {}) { return { type: "paragraph", attrs, content: Array.isArray(children) ? children : [textNode(children)] }; }
function heading(level, text) { return { type: "heading", attrs: { level }, content: [textNode(text)] }; }
function otl(blocks) {
  return { content: { type: "logic_block", content: [{ type: "block_tile", content: blocks }] } };
}

test("wpsDocToken parses /l/ and /view/l/ links", () => {
  assert.equal(wpsDocToken("https://www.kdocs.cn/l/ck1mE4vgjirr"), "ck1mE4vgjirr");
  assert.equal(wpsDocToken("https://www.kdocs.cn/view/l/abcDEF123"), "abcDEF123");
  assert.equal(wpsDocToken("https://www.kdocs.cn/"), "");
});

test("applyMarks wraps link, bold, italic, code, strike", () => {
  assert.equal(applyMarks("t", [{ type: "link", attrs: { href: "http://x" } }]), "[t](<http://x>)");
  assert.equal(applyMarks("t", [{ type: "bold" }]), "**t**");
  assert.equal(applyMarks("t", [{ type: "italic" }]), "*t*");
  assert.equal(applyMarks("t", [{ type: "inlineCode" }]), "`t`");
  assert.equal(applyMarks("t", [{ type: "strikethrough" }]), "~~t~~");
});

test("otlToMarkdown renders title, heading, paragraph, emoji, link, image", () => {
  const doc = otl([
    { type: "outline-title", content: [textNode("外卖红包")] },
    heading(1, "美团外卖"),
    para([textNode("全天可领"), { type: "emoji", attrs: { emoji: "👇" } }]),
    para([textNode("链接", [{ type: "link", attrs: { href: "http://dpurl.cn/x" } }])]),
    { type: "picture", attrs: { sourceKey: "KEY1", caption: "图" } },
  ]);
  const md = otlToMarkdown(doc, { KEY1: "https://cdn.wps/img.png" });
  assert.match(md, /^# 外卖红包/m);
  assert.match(md, /^## 美团外卖/m);
  assert.match(md, /全天可领👇/);
  assert.match(md, /\[链接\]\(<http:\/\/dpurl\.cn\/x>\)/);
  assert.match(md, /!\[图\]\(<https:\/\/cdn\.wps\/img\.png>\)/);
});

test("otlToMarkdown renders bullet and ordered lists with nesting level", () => {
  const doc = otl([
    para("一级项", { listType: "bullet", listLevel: 0 }),
    para("子项", { listType: "bullet", listLevel: 1 }),
    para("有序项", { listType: "ordered", listLevel: 0 }),
  ]);
  const md = otlToMarkdown(doc);
  assert.match(md, /^- 一级项/m);
  assert.match(md, /^ {2}- 子项/m);
  assert.match(md, /^1\. 有序项/m);
});

test("otlToMarkdown degrades unknown leaf to text and title falls back", () => {
  const doc = otl([{ type: "mystery", content: [textNode("兜底")] }]);
  assert.match(otlToMarkdown(doc), /兜底/);
  assert.equal(otlTitle(doc), "");
});

test("extractWpsDoc picks open/otl for office_type o and labels wps-otl", async () => {
  const calls = [];
  const doc = otl([{ type: "outline-title", content: [textNode("标题文档")] }, para("正文")]);
  const fileInfo = { file: { name: "标题文档.otl", office_type: "o", create_time: 1747930231, creator: { name: "未命名" } } };
  const result = await extractWpsDoc("https://www.kdocs.cn/l/ck1mE4vgjirr", {
    collectSessionCookies: async (service, origin) => { calls.push([service, origin]); return "csrf=my-csrf-token; other=1"; },
    fetchImpl: async (target, init) => {
      calls.push({ target, method: init.method, headers: init.headers });
      if (/\/file\/ck1mE4vgjirr$/.test(target)) return { status: 200, json: async () => fileInfo };
      if (/\/open\/otl$/.test(target)) return { status: 200, json: async () => doc };
      if (/\/attachment\/shapes$/.test(target)) return { status: 200, json: async () => ({ data: {} }) };
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.deepEqual(calls[0], ["wps", "https://www.kdocs.cn/"]);
  // 先 file 接口拿 office_type,再 open/otl
  assert.match(calls[1].target, /\/file\/ck1mE4vgjirr$/);
  const otlReq = calls[2];
  assert.equal(otlReq.target, "https://www.kdocs.cn/api/v3/office/file/ck1mE4vgjirr/open/otl");
  assert.equal(otlReq.method, "POST");
  assert.equal(otlReq.headers["x-csrf-rand"], "my-csrf-token");
  assert.equal(otlReq.headers["x-forward-region"], "yxy");
  assert.equal(result.extractionMethod, "wps-otl");
  assert.equal(result.title, "标题文档");
  assert.match(result.markdown, /正文/);
  assert.equal(result.author, "未命名");
  assert.match(result.publishedAt, /^2025-/);
  assert.deepEqual(result.imageHeaders, { cookie: "csrf=my-csrf-token; other=1" });
});

test("extractWpsDoc picks open/md for office_type md and labels wps-md", async () => {
  const mdText = "# 长会话攻略\n\n正文内容足够长以满足阈值检查。".repeat(3);
  const fileInfo = { file: { name: "长会话攻略.md", office_type: "md", create_time: 1788759635, creator: { name: "WPS_1006143687" } } };
  const result = await extractWpsDoc("https://www.kdocs.cn/l/cmWNSE8HVadT", {
    collectSessionCookies: async () => "csrf=t",
    fetchImpl: async (target, init) => {
      if (/\/file\/cmWNSE8HVadT$/.test(target)) return { status: 200, json: async () => fileInfo };
      if (/\/open\/md$/.test(target)) return { status: 200, text: async () => mdText };
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.equal(result.extractionMethod, "wps-md");
  assert.equal(result.title, "长会话攻略.md");
  assert.match(result.markdown, /长会话攻略/);
  assert.equal(result.author, "WPS_1006143687");
  assert.match(result.publishedAt, /^2026-/);
});

test("extractWpsDoc throws WPS_DOCS_UNREACHABLE for unsupported office_type (et/wps/wpp)", async () => {
  const fileInfo = { file: { name: "表格.xls", office_type: "s", create_time: 0, creator: {} } };
  await assert.rejects(
    extractWpsDoc("https://www.kdocs.cn/l/abc123", {
      collectSessionCookies: async () => "csrf=t",
      fetchImpl: async (target) => {
        if (/\/file\/abc123$/.test(target)) return { status: 200, json: async () => fileInfo };
        return { status: 200, json: async () => ({}) };
      },
    }),
    (error) => error.code === "WPS_DOCS_UNREACHABLE" && /et|wps|wpp|pdf/.test(error.message) === false && /暂不支持/.test(error.message),
  );
});

test("extractWpsDoc fetches picture URLs via POST shapes with attachment_id objects", async () => {
  const doc = otl([
    { type: "outline-title", content: [textNode("图文档")] },
    { type: "picture", attrs: { sourceKey: "KEY1" } },
    para("图后正文"),
  ]);
  const shapes = { data: { KEY1: { url: "https://cdn.wps/img1.jpeg" } } };
  const result = await extractWpsDoc("https://www.kdocs.cn/l/abc123", {
    collectSessionCookies: async () => "csrf=t",
    fetchImpl: async (target, init) => {
      if (/\/file\/abc123$/.test(target)) return { status: 200, json: async () => ({ file: { name: "图文档.otl", office_type: "o", create_time: 0, creator: {} } }) };
      if (/\/open\/otl$/.test(target)) return { status: 200, json: async () => doc };
      if (/\/attachment\/shapes$/.test(target)) {
        const body = JSON.parse(init.body);
        assert.equal(init.method, "POST");
        assert.deepEqual(body.objects, [{ attachment_id: "KEY1", max_edge: 1180, source: "" }]);
        return { status: 200, json: async () => shapes };
      }
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.match(result.markdown, /!\[\]\(<https:\/\/cdn\.wps\/img1\.jpeg>\)/);
  assert.deepEqual(result.images, ["https://cdn.wps/img1.jpeg"]);
  assert.equal(result.author, "");
  assert.equal(result.publishedAt, "");
});

test("extractWpsDoc throws WPS_DOCS_UNREACHABLE on non-2xx (fallback handled by caller)", async () => {
  const fileInfo = { file: { name: "x.otl", office_type: "o", create_time: 0, creator: {} } };
  await assert.rejects(
    extractWpsDoc("https://www.kdocs.cn/l/ck1mE4vgjirr", {
      collectSessionCookies: async () => "csrf=x",
      fetchImpl: async (target) => {
        if (/\/file\/ck1mE4vgjirr$/.test(target)) return { status: 200, json: async () => fileInfo };
        return { status: 401, json: async () => ({}) };
      },
    }),
    (error) => error.code === "WPS_DOCS_UNREACHABLE",
  );
});

test("extractWpsDoc rejects an unparseable token URL", async () => {
  await assert.rejects(
    extractWpsDoc("https://www.kdocs.cn/", { collectSessionCookies: async () => "" }),
    (error) => error.code === "WPS_DOCS_INVALID_URL",
  );
});
