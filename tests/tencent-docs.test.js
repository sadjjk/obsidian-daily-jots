"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTencentDoc, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl } = require("../src/clip/cloud-docs/tencent-docs");

test("tencent rendered chrome lines are stripped while body lines survive", () => {
  const markdown = [
    "菜单",
    "插入",
    "标题 1",
    "默认字体",
    "京东淘宝618每日红包领取",
    "618夸克 迅雷 各大视频音乐会员优惠活动",
    "View only. Log in to edit it.",
    "Log in now",
    "更多",
    "快捷工具",
    "PDF转换",
    "排版美化",
    "打印",
    "大纲",
    "正文中合法出现的词:如何在菜单栏插入表格属于长行内容,不应被剥离",
  ].join("\n");
  const cleaned = stripTencentChrome(markdown);
  assert.deepEqual(
    cleaned.split("\n").filter((line) => line.trim()),
    [
      "京东淘宝618每日红包领取",
      "618夸克 迅雷 各大视频音乐会员优惠活动",
      "正文中合法出现的词:如何在菜单栏插入表格属于长行内容,不应被剥离",
    ],
  );
});

test("tencent chrome stripping keeps blank lines and normal punctuation lines", () => {
  const markdown = "第一段\n\n**加粗内容**\n\n1. 有序列表项\n";
  assert.equal(stripTencentChrome(markdown), markdown);
});

test("tencent chrome stripping removes sync banner and font metric lines", () => {
  const markdown = [
    "正在同步内容...",
    "mmmmmmmmmmlli1ƒ⁇!",
    "mmmmmmmmmmlli1ƒ⁇!",
    "真实正文行",
    "text",
    "M",
  ].join("\n");
  const cleaned = stripTencentChrome(markdown);
  assert.deepEqual(cleaned.split("\n").filter((line) => line.trim()), ["真实正文行", "M"]);
});

// ==== opendoc 提取 ====

function docPayload(mutations, extra = {}) {
  return {
    clientVars: {
      title: "测试文档",
      userName: "张三",
      ...extra,
      collab_client_vars: { initialAttributedText: { text: [{ commands: [{ mutations }] }] } },
    },
  };
}

test("tencent opendoc url works for docs.qq.com and doc.weixin.qq.com", () => {
  assert.equal(tencentHostForUrl("https://docs.qq.com/doc/DR25Mc1hCeGdaVk1o"), "docs.qq.com");
  assert.equal(tencentHostForUrl("https://doc.weixin.qq.com/doc/m2nABC?scode=xyz"), "doc.weixin.qq.com");
  assert.equal(tencentHostForUrl("https://example.com/doc/x"), "");
  const apiUrl = tencentDocApiUrl("https://docs.qq.com/doc/DR25Mc1hCeGdaVk1o");
  assert.match(apiUrl, /^https:\/\/docs\.qq\.com\/dop-api\/opendoc\?id=DR25Mc1hCeGdaVk1o&/);
  assert.match(apiUrl, /normal=1&noEscape=1&outformat=1&doc_chunk_flag=1&t=\d+/);
  const wecomUrl = tencentDocApiUrl("https://doc.weixin.qq.com/doc/m2nABC?scode=xyz");
  assert.match(wecomUrl, /^https:\/\/doc\.weixin\.qq\.com\/dop-api\/opendoc\?/);
  assert.match(wecomUrl, /scode=xyz/);
});

test("tencent mutations convert to markdown with heading, bold, image, and table", () => {
  const text = "一级标题\r粗体正文\r\x1a名称\x07数量\r\x07\x06苹果\x073\r尾行\r";
  const pic = {
    blipFill: { blip: { embed: "https://docs.gtimg.com/img.png?w=800&h=600" } },
    nvPicPr: { cNvPr: { descr: "配图说明" } },
  };
  const mutations = [
    { s: text },
    { ty: "mp", bi: 0, ei: 4, pr: { run: { sz: { val: 480 } } } },
    { ty: "mp", bi: 5, ei: 9, pr: { run: { b: { val: true } } } },
    { ty: "mp", bi: 16, ei: 17, pr: { drawing: { inlineKeyword: { graphic: { graphicData: { pic } } } } } },
  ];  const { title, author, markdown, images } = parseTencentDocPayload(docPayload(mutations));
  assert.equal(title, "测试文档");
  assert.equal(author, "张三");
  assert.deepEqual(images, ["https://docs.gtimg.com/img.png?w=800&h=600"]);
  assert.match(markdown, /# 一级标题/);
  assert.match(markdown, /\*\*粗体正文\*\*/);
  assert.match(markdown, /\| 名称 \| 数量 \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| 苹果 \| 3 \|/);
  assert.match(markdown, /!\[配图说明\]\(https:\/\/docs\.gtimg\.com\/img\.png\?w=800&h=600\)/);
  assert.match(markdown, /尾行/);
  assert.doesNotMatch(markdown, /\x1a|\x07|\x06/);
});

test("tencent markdown converter keeps code lines in a fence and lists as list items", () => {
  const text = "要点如下\r\x1dconst port = 17809\r\x1dreturn port\r• 甲\r• 乙\r1. 第一步\r";
  const markdown = tencentDocToMarkdown(text, {}, {}, "测试文档");
  assert.match(markdown, /````\nconst port = 17809\nreturn port\n````/);
  assert.match(markdown, /^- 甲$/m);
  assert.match(markdown, /^- 乙$/m);
  assert.match(markdown, /^1\. 第一步$/m);
});

test("tencent TOC field codes and anchor entries are stripped, bold title line is skipped", () => {
  const text = "测试\r**目录**\rTOC \\o \"1-1\" \\h \\z \\u [\"section-1\"](\\l)\r[\"section-2\"](\\l)\r## **一、正文标题**\r正文段\r";
  const formatMap = {};
  const markdown = tencentDocToMarkdown(text, formatMap, {}, "测试");
  assert.doesNotMatch(markdown, /TOC \\o/);
  assert.doesNotMatch(markdown, /\["section-\d"\]/);
  assert.match(markdown, /## \*\*一、正文标题\*\*/);
  assert.match(markdown, /\*\*目录\*\*/);
  assert.doesNotMatch(markdown, /^# 测试$/m);
});

test("tencent extract fetches opendoc with session cookie and parses the body-only response", async () => {
  const text = "正文一段\r";
  const payload = docPayload([{ s: text }]);
  const cookieCalls = [];
  const fetchCalls = [];
  const article = await extractTencentDoc("https://docs.qq.com/doc/DR25Mc1hCeGdaVk1o", {
    collectSessionCookies: async (service, target) => { cookieCalls.push({ service, target }); return "SID=tok"; },
    fetchImpl: async (target, init) => {
      fetchCalls.push({ target, headers: init.headers });
      return { headers: { get: () => "application/json" }, body: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() };
    },
  });
  assert.deepEqual(cookieCalls[0], { service: "tencent", target: "https://docs.qq.com/" });
  assert.equal(fetchCalls[0].headers.cookie, "SID=tok");
  assert.match(fetchCalls[0].target, /\/dop-api\/opendoc\?id=DR25Mc1hCeGdaVk1o/);
  assert.equal(article.markdown.trim(), "正文一段");
  assert.equal(article.title, "测试文档");
  assert.equal(article.author, "张三");
  assert.deepEqual(article.imageHeaders, { cookie: "SID=tok" });
});

test("tencent extract requires a session and rejects non-doc links", async () => {
  await assert.rejects(
    extractTencentDoc("https://docs.qq.com/doc/DR25Mc1hCeGdaVk1o", { collectSessionCookies: async () => "" }),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED",
  );
  assert.throws(() => tencentDocApiUrl("https://example.com/x"), /腾讯文档/);
});
