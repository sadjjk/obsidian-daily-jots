"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTencentDoc, extractTencentFileExportForTencent, parseTencentDocPayload, stripTencentChrome, tencentDocApiUrl, tencentDocToMarkdown, tencentHostForUrl, tencentSessionServiceForUrl, tencentSiteNameForUrl } = require("../src/clip/cloud-docs/tencent-docs");
const { localIso } = require("../src/core/util");

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

test("wecom doc links use an independent session service and site name", () => {
  assert.equal(tencentSessionServiceForUrl("https://docs.qq.com/doc/DR25"), "tencent");
  assert.equal(tencentSessionServiceForUrl("https://doc.weixin.qq.com/doc/m2nABC?scode=xyz"), "wecomdoc");
  assert.equal(tencentSiteNameForUrl("https://docs.qq.com/doc/DR25"), "腾讯文档");
  assert.equal(tencentSiteNameForUrl("https://doc.weixin.qq.com/doc/m2nABC"), "企微文档");
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

test("wecom paragraph styles drive headings, code paragraphs, and quotes", () => {
  // 段落属性挂在段尾 \r 位置,值已预解析为语义 { heading, code }
  const text = "底层数据依赖\r2.1 测试环节\r2.2.1 工单申请\rimport pandas as pd\r正文段落\r引用引言\r";
  const paraStyleAt = { 6: { heading: 2 }, 15: { heading: 3 }, 26: { heading: 4 }, 46: { code: true }, 51: {} };
  const blockQuoteAt = { 56: true };
  const markdown = tencentDocToMarkdown(text, {}, {}, "", paraStyleAt, blockQuoteAt);
  assert.match(markdown, /^## 底层数据依赖$/m);
  assert.match(markdown, /^### 2\.1 测试环节$/m);
  assert.match(markdown, /^#### 2\.2\.1 工单申请$/m);
  assert.match(markdown, /````\nimport pandas as pd\n````/);
  assert.match(markdown, /^正文段落$/m);
  assert.match(markdown, /^> 引用引言$/m);
});

test("wecom pr.styles table resolves heading levels by name, not fixed ids", () => {
  // 样式 id 逐篇可变:styles 表的 name/outlineLvl 是稳定语义(每日进展实测 poycdr=heading 3)
  const payload = docPayload([{ s: "04月25日\r正文段\r" }]);
  const text0 = payload.clientVars.collab_client_vars.initialAttributedText.text[0];
  text0.commands[0].mutations.push(
    { ty: "mp", bi: 6, ei: 7, pr: { paragraph: { pStyle: { val: "poycdr" } } } },
    { ty: "mp", bi: 10, ei: 11, pr: { paragraph: { pStyle: { val: "ablt93" } } } },
    { ty: "mp", bi: 0, ei: 0, pr: { styles: { style: { poycdr: { name: { val: "heading 3" }, pPr: { outlineLvl: { val: 2 } } }, ablt93: { name: { val: "Normal" } } } } } },
  );
  const parsed = parseTencentDocPayload(payload);
  assert.match(parsed.markdown, /^### 04月25日$/m);
  assert.match(parsed.markdown, /^正文段$/m);
});

test("wecom code block markers \\x0f/\\x1e/\\x1d and structured links resolve", () => {
  const text = "说明如下\r\x0f\x1e\x1cimport os\rimport sys\r\x1d\x1e\r参考 \x13HYPERLINK https://example.com/x\x14示例页面\x15 继续\r提及 \x13MENTION_WXWORK at-100 0 0 w3_doc\x14@李石\x15。\r";
  const markdown = tencentDocToMarkdown(text, {}, {}, "");
  assert.match(markdown, /````\nimport os\nimport sys\n````/);
  assert.match(markdown, /\[示例页面\]\(https:\/\/example\.com\/x\)/);
  assert.match(markdown, /提及 @李石。/);
  assert.doesNotMatch(markdown, /HYPERLINK/);
  assert.doesNotMatch(markdown, /MENTION_WXWORK/);
  assert.doesNotMatch(markdown, /[\x13\x14\x15]/);
});

test("tencent decorative \\x0f without \\x1d does not open a code block and toc styles are stripped", () => {
  const payload = docPayload([{ s: "前言\r建议篇幅：3000 字\x0f核心立意：正文段\r目录\r\x13 TOC \\o \"1-1\" \\h \\z \\u \x14\x13 HYPERLINK \\l \"section-1\" \x14一、引言\x15\t\x13 PAGEREF section-1 \\h \x141\x15\r正文继续\r" }]);
  const text0 = payload.clientVars.collab_client_vars.initialAttributedText.text[0];
  // 段尾 \r 实测:目录=26、TOC 条目行=112、正文行=117
  text0.commands[0].mutations.push(
    { ty: "mp", bi: 112, ei: 113, pr: { paragraph: { pStyle: { val: "000003" } } } },
    { ty: "mp", bi: 117, ei: 118, pr: { paragraph: { pStyle: { val: "000004" } } } },
    { ty: "mp", bi: 0, ei: 0, pr: { styles: { style: { "000004": { name: { val: "heading 2" } }, "000003": { name: { val: "toc 1" } } } } } },
  );
  const { markdown } = parseTencentDocPayload(payload);
  assert.match(markdown, /## 正文继续/);
  assert.doesNotMatch(markdown, /````/);
  assert.doesNotMatch(markdown, /HYPERLINK|PAGEREF|TOC \\o/);
  assert.doesNotMatch(markdown, /一、引言/);
  assert.match(markdown, /前言/);
  assert.match(markdown, /核心立意：正文段/);
  assert.match(markdown, /目录/);
});

test("wecom mention directives are stripped while mention names survive", () => {
  const text = "MENTION_WXWORK at-1714027908250-0 0 0 w3_ABQAcgYGAFIO1ijvHcNRtaZE6oD1U_p@李石。\rMENTION_WXWORK at-1714027908235-1688851236418068 1688851236418068 w3_ABQAcgYGAFIO1ijvHcNRtaZE6oD1U_p@杨懿宁 今日进展\r";
  const markdown = tencentDocToMarkdown(text, {}, {}, "测试文档");
  assert.match(markdown, /@李石。/);
  assert.match(markdown, /@杨懿宁 今日进展/);
  assert.doesNotMatch(markdown, /MENTION_WXWORK/);
  assert.doesNotMatch(markdown, /at-1714027908250/);
});

test("wecom author ignores id-like values and falls back to session user", () => {
  const payload = docPayload([{ s: "正文\r" }]);
  payload.clientVars.userName = "王金宇";
  const mutations = payload.clientVars.collab_client_vars.initialAttributedText.text[0].commands[0].mutations;
  mutations.push({ ty: "mp", bi: 0, ei: 2, pr: { run: { author: "p.13102701727529031" } } });
  const parsed = parseTencentDocPayload(payload);
  assert.equal(parsed.author, "王金宇");
});

test("tencent author prefers the doc owner and published_at parses create time", () => {
  const payload = docPayload([{ s: "正文\r" }]);
  payload.clientVars.userName = "剪藏人";
  payload.clientVars.ownerName = "王金宇";
  payload.clientVars.createTime = 1745577637;
  const parsed = parseTencentDocPayload(payload);
  assert.equal(parsed.author, "王金宇");
  assert.equal(parsed.publishedAt, localIso(new Date(1745577637 * 1000)));
  const fallback = parseTencentDocPayload({ ...docPayload([{ s: "正文\r" }]), clientVars: { ...docPayload([{ s: "正文\r" }]).clientVars, userName: "剪藏人" } });
  assert.equal(fallback.author, "剪藏人");
  assert.equal(fallback.publishedAt, "");
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

// ==== sheet/slide 导出链(opendoc 换 globalPadId → export_office → 轮询 → COS 下载) ====

function exportMockFetch(opendocPayload, { pollPayloads, downloadBuffer, downloadDisposition, descPayload, descFails } = {}) {
  const calls = [];
  let pollCount = 0;
  const fetchImpl = async (target, init = {}) => {
    calls.push({ target, init });
    const jsonResponse = (payload) => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      body: (async function* () { yield Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)); })(),
    });
    if (target.includes("/dop-api/opendoc")) return jsonResponse(opendocPayload);
    if (target.includes("/v2/drive/file/desc")) {
      if (descFails) return { ok: false, status: 500, headers: { get: () => "text/html" }, body: (async function* () { yield Buffer.from("boom"); })() };
      return jsonResponse(descPayload);
    }
    if (target.includes("/v1/export/export_office")) return jsonResponse({ ret: 0, operationId: "op-1" });
    if (target.includes("/v1/export/query_progress")) {
      const payload = pollPayloads[Math.min(pollCount, pollPayloads.length - 1)];
      pollCount += 1;
      return jsonResponse(payload);
    }
    return {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-disposition" ? downloadDisposition : "application/octet-stream") },
      body: (async function* () { yield downloadBuffer; })(),
    };
  };
  return { fetchImpl, calls };
}

test("tencent sheet export downloads xlsx buffer with UTF-8 filename", async () => {
  const opendocPayload = {
    globalPadId: "300000000$ZyCPHyECyGCs",
    padType: "sheet",
    initialTitle: "测试表格",
  };
  const downloadBuffer = Buffer.from("504b0304fake-zip-data");
  const { fetchImpl, calls } = exportMockFetch(opendocPayload, {
    pollPayloads: [
      { ret: 0, status: "Processing", progress: 50 },
      { ret: 0, status: "Done", progress: 100, file_url: "https://cos.example/file.xlsx?sig=1" },
    ],
    downloadBuffer,
    downloadDisposition: "attachment; filename=\"t.xlsx\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E8%A1%A8%E6%A0%BC.xlsx",
    descPayload: { ret: 0, result: { ownerNick: "迷住-看报价单专用", createTime: "1735880146444", name: "测试表格" } },
  });
  await assert.rejects(
    extractTencentFileExportForTencent("https://docs.qq.com/sheet/DVnFYSGZ0cFJiZGpM?tab=BB08J2", {
      collectSessionCookies: async () => "SID=tok",
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "TENCENT_DOCS_BINARY");
      assert.ok(Buffer.isBuffer(error.buffer));
      assert.ok(error.buffer.includes(downloadBuffer));
      assert.equal(error.fileName, "测试表格.xlsx");       // filename* UTF-8 优先于 ASCII fallback
      assert.equal(error.meta.padType, "sheet");
      assert.match(error.meta.mimeType, /spreadsheetml\.sheet/);
      assert.equal(error.meta.author, "迷住-看报价单专用"); // file/desc 的 ownerNick
      assert.match(error.meta.publishedAt, /^\d{4}-\d{2}-\d{2}T/); // createTime(ms) → localIso
      return true;
    },
  );
  // file/desc 请求:JSON body,file_id 为 globalPadId 去前缀的 padId 段
  const descCall = calls.find((c) => c.target.includes("/v2/drive/file/desc"));
  assert.deepEqual(JSON.parse(descCall.init.body), { file_id: "ZyCPHyECyGCs", xsrf: "" });
  const postCall = calls.find((c) => c.target.includes("/v1/export/export_office"));
  assert.equal(postCall.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(postCall.init.headers["x-requested-with"], "XMLHttpRequest");
  assert.match(postCall.init.body, /docId=300000000%24ZyCPHyECyGCs/);  // $ 已编码
  assert.match(postCall.init.body, /exportType=0/);
  // 下载请求不带会话 cookie(COS 预签名直链)
  const downloadCall = calls[calls.length - 1];
  assert.ok(downloadCall.target.includes("cos.example"));
  assert.ok(!downloadCall.init.headers.cookie);
});

test("tencent slide export uses pptx metadata and tolerates desc failure", async () => {
  const { fetchImpl } = exportMockFetch(
    { globalPadId: "300000000$ZyCPHyECyGCs", padType: "slide", initialTitle: "演示" },
    {
      pollPayloads: [{ ret: 0, status: "Done", progress: 100, file_url: "https://cos.example/f" }],
      downloadBuffer: Buffer.from("504b0304pptx"),
      downloadDisposition: "attachment; filename=\"12幢架空层提升建议.pptx\"",
      descFails: true,                                   // file/desc 挂掉也不阻塞导出
    },
  );
  await assert.rejects(
    extractTencentFileExportForTencent("https://docs.qq.com/slide/DWnlDUEh5RUN5R0Nz", {
      collectSessionCookies: async () => "SID=tok",
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "TENCENT_DOCS_BINARY");
      assert.match(error.meta.mimeType, /presentationml\.presentation/);
      assert.equal(error.meta.author, "");               // desc 失败 → meta 留空
      assert.equal(error.meta.publishedAt, "");
      return true;
    },
  );
});

test("tencent export rejects missing session and unsupported pad types", async () => {
  await assert.rejects(
    extractTencentFileExportForTencent("https://docs.qq.com/sheet/DVnFYSGZ0cFJiZGpM", { collectSessionCookies: async () => "" }),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED",
  );
  const { fetchImpl } = exportMockFetch(
    { globalPadId: "300000000$ZyCPHyECyGCs", padType: "doc", initialTitle: "文档" },
    { pollPayloads: [], downloadBuffer: Buffer.from(""), downloadDisposition: "" },
  );
  await assert.rejects(
    extractTencentFileExportForTencent("https://docs.qq.com/doc/DR25Mc1hCeGdaVk1o", {
      collectSessionCookies: async () => "SID=tok",
      fetchImpl,
    }),
    (error) => error.code === "TENCENT_DOCS_EXPORT_UNSUPPORTED",
  );
});
