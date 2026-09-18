"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDentryKey, fetchDocumentData, packageToHtml, extractDingtalkDoc } = require("../src/core/dingtalk-docs");

test("resolveDentryKey takes the key straight from note/preview URL params", async () => {
  const key = await resolveDentryKey("https://alidocs.dingtalk.com/note/preview?dentryKey=abc123def456&other=1");
  assert.equal(key, "abc123def456");
});

test("resolveDentryKey wide-matches the base62 dentryKey embedded in the page HTML", async () => {
  const html = '<script>window.__BOOT__={"dentryInfo":{"dentryKey":"nmbmj1wmconnN80l"}}</script>';
  const seen = [];
  const jar = new Map([["doc_atoken", "tok"]]);
  const key = await resolveDentryKey("https://alidocs.dingtalk.com/i/nodes/xxx", jar, async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    return { ok: true, status: 200, text: async () => html, headers: {} };
  });
  assert.equal(key, "nmbmj1wmconnN80l");
  assert.equal(seen[0].headers.cookie, "doc_atoken=tok");
  assert.equal(seen[0].headers.origin, "https://alidocs.dingtalk.com");
});

test("resolveDentryKey merges set-cookie from the page response into the jar", async () => {
  const html = '{"dentryKey":"nmbmj1wmconnN80l"}';
  const jar = new Map();
  await resolveDentryKey("https://alidocs.dingtalk.com/i/nodes/xxx", jar, async () => ({
    ok: true, status: 200, text: async () => html,
    headers: { getSetCookie: () => ["XSRF-TOKEN=abc123; Path=/; Domain=.dingtalk.com", "cna=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT"] },
  }));
  assert.equal(jar.get("XSRF-TOKEN"), "abc123");
  assert.equal(jar.get("cna"), "xyz");
});

test("resolveDentryKey surfaces the login guidance error when the page has no dentryKey", async () => {
  await assert.rejects(
    () => resolveDentryKey("https://alidocs.dingtalk.com/i/nodes/xxx", new Map(), async () => ({ ok: true, status: 200, text: async () => "<html>login dingtalk</html>", headers: {} })),
    (error) => error.code === "DINGTALK_DENTRY_KEY_NOT_FOUND" && /浏览器会话/.test(error.message),
  );
});

test("resolveDentryKey rejects non-2xx pages with a diagnostic code", async () => {
  await assert.rejects(
    () => resolveDentryKey("https://alidocs.dingtalk.com/i/nodes/xxx", new Map(), async () => ({ ok: false, status: 502, text: async () => "", headers: {} })),
    (error) => error.code === "DINGTALK_DOCS_UNREACHABLE" && /502/.test(error.message),
  );
});

test("fetchDocumentData posts a-dentry-key plus jar cookies and validates isSuccess", async () => {
  const seen = [];
  const jar = new Map([["doc_atoken", "tok"], ["stayLogin", "1"]]);
  const payload = await fetchDocumentData("nmbmj1wmconnN80l", jar, async (url, options) => {
    seen.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    return { ok: true, status: 200, json: async () => ({ status: 0, isSuccess: true, data: {} }), headers: {} };
  });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers["a-dentry-key"], "nmbmj1wmconnN80l");
  assert.equal(seen[0].headers.cookie, "doc_atoken=tok; stayLogin=1");
  assert.deepEqual(JSON.parse(seen[0].body), { fetchBody: true });
  assert.deepEqual(payload, { status: 0, isSuccess: true, data: {} });

  await assert.rejects(
    () => fetchDocumentData("nmbmj1wmconnN80l", new Map(), async () => ({ ok: true, status: 200, json: async () => ({ status: 1, isSuccess: false }), headers: {} })),
    (error) => error.code === "DINGTALK_DOCS_API_ERROR",
  );
});

function packageSample() {
  return JSON.stringify({
    fileMetaInfo: { name: "测试文档" },
    parts: { main: { data: { body: ["root", {},
      ["h1", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "标题一"]]],
      ["p", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf", "bold": true, "italic": true }, "粗斜体"]]],
      ["p", {}, ["img", { "src": "https://down.dingtalk.com/ddmedia/abc.png", "alt": "图" }]],
      ["p", {}, ["img", { "src": "/core/api/resources/img/5eecdaf48460cde5b35547b8056687dd6f438ca4bd5a4c8dc1b0aaf4285a4450cf9289de50d8305639e8703ac5556d0d" }]],
      ["heading", { "level": 3 }, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "三级标题"]]],
      ["table", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "表格兜底"]]],
    ] } } },
  });
}

test("packageToHtml renders title, headings, bold+italic, images, links and unknown-node fallback", () => {
  const { title, html } = packageToHtml({ data: { documentContent: packageSample() } });
  assert.equal(title, "测试文档");
  assert.ok(html.includes("<h1>标题一</h1>"));
  assert.ok(/<strong><em>粗斜体<\/em><\/strong>|<em><strong>粗斜体<\/strong><\/em>/.test(html));
  assert.ok(html.includes('<img src="https://down.dingtalk.com/ddmedia/abc.png" alt="图">'));
  // 实测:文档内嵌图片是 /core/api/resources/img/<hash> 相对路径,必须拼成绝对 URL
  assert.ok(html.includes('<img src="https://alidocs.dingtalk.com/core/api/resources/img/5eecdaf48460cde5b35547b8056687dd6f438ca4bd5a4c8dc1b0aaf4285a4450cf9289de50d8305639e8703ac5556d0d"'));
  assert.ok(html.includes("<h3>三级标题</h3>"));
  assert.ok(html.includes("表格兜底"));
  assert.doesNotMatch(html, /\[object Object\]/); // props 不泄漏为正文
});

test("packageToHtml resolves the body part in knowledge-base note/preview packages", () => {
  // 实测 note/preview:main.data 只有文件元数据,正文在 UUID key part 的 data.body
  const h1 = ["h1", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "ragflow 介绍"]]];
  const para = [
    "p", {},
    ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "参考资料："]],
    ["a", { "href": "https://ragflow.io/docs/dev/" }, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "官方文档"]]],
  ];
  const body = ["root", {}, h1, para];
  const pkg = JSON.stringify({
    parts: {
      "5524b0d8-aad3-4973-a566-cfcdcc7a20b4": {
        data: { fileName: "ragflow——一个非常强大的开源RAG引擎", fileType: "adoc", url: "https://alidocs.dingtalk.com/i/nodes/G53mjyd80pAor2A7SdO5n3p986zbX04v" },
      },
      "00000000-0000-0000-0000-000000000001": { data: { body } },
    },
  });
  const { title, html } = packageToHtml({ data: { documentContent: pkg } });
  assert.equal(title, "ragflow——一个非常强大的开源RAG引擎"); // fileMetaInfo 缺失时兜底 fileName
  assert.ok(html.includes("<h1>ragflow 介绍</h1>"));
  assert.ok(html.includes('<a href="https://ragflow.io/docs/dev/">官方文档</a>'));
});

test("packageToHtml unwraps resultValue and checkpoint layers (observed response shapes)", () => {
  const sample = JSON.parse(packageSample());
  assert.equal(packageToHtml({ data: { documentContent: packageSample() } }).title, "测试文档");
  assert.equal(packageToHtml({ resultValue: { documentContent: packageSample() } }).title, "测试文档");
  assert.equal(packageToHtml({ data: { documentContent: JSON.stringify({ checkpoint: { content: packageSample() } }) } }).title, "测试文档");
  assert.throws(() => packageToHtml({ data: {} }), (error) => error.code === "DINGTALK_PACKAGE_MALFORMED");
  void sample;
});

test("extractDingtalkDoc injects session cookies into GET and POST and skips the rendered path", async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), headers: options.headers || {} });
    if (String(url).includes("/api/document/data")) {
      return { ok: true, status: 200, json: async () => ({ status: 0, isSuccess: true, data: { documentContent: packageSample() } }) };
    }
    return { ok: true, status: 200, text: async () => '{"dentryKey":"nmbmj1wmconnN80l"}' };
  };
  const manager = { collectCookies: async (service, warmupUrl) => {
    assert.equal(service, "dingtalk");
    assert.equal(warmupUrl, "https://alidocs.dingtalk.com/");
    return "doc_atoken=tok; stayLogin=1";
  } };
  const doc = await extractDingtalkDoc("https://alidocs.dingtalk.com/i/nodes/gpG2NdyVX3mmZxQYHA1AGnXAWMwvDqPk?utm_scene=person_space", { webSessionManager: manager, fetchImpl });
  assert.equal(doc.title, "测试文档");
  assert.ok(doc.html.includes("标题一"));
  assert.equal(doc.cookieHeader, "doc_atoken=tok; stayLogin=1");
  assert.equal(doc.imageHeaders.cookie, "doc_atoken=tok; stayLogin=1");
  assert.equal(doc.imageHeaders["a-dentry-key"], "nmbmj1wmconnN80l");
  assert.ok(seen.every((call) => call.headers.cookie === "doc_atoken=tok; stayLogin=1"));
  assert.ok(seen.some((call) => call.headers["a-dentry-key"] === "nmbmj1wmconnN80l"));
});

test("extractDingtalkDoc rejects non-alidocs URLs without touching the session", async () => {
  let touched = false;
  const manager = { collectCookies: async () => { touched = true; return ""; } };
  await assert.rejects(
    () => extractDingtalkDoc("https://example.com/i/nodes/xxx", { webSessionManager: manager }),
    (error) => error.code === "DINGTALK_DOCS_URL_MISMATCH",
  );
  assert.equal(touched, false);
});

// 回归:safeFetch 的 response 是 {status, ok, headers, body(async iterable)},没有 text/json 方法
// (生产实测报错 "e.text is not a function")。模块必须双形态兼容。
function safeFetchStyleResponse(bodyText, setCookieValue) {
  const buffer = Buffer.from(bodyText, "utf8");
  return {
    status: 200,
    ok: true,
    headers: { get: (name) => {
      const key = String(name).toLowerCase();
      if (key === "content-length") return String(buffer.length);
      if (key === "set-cookie") return setCookieValue || null;
      return null;
    } },
    body: (async function* () { yield buffer; })(),
  };
}

test("responses without text/json (safeFetch shape) are read via the body stream", async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push(String(url));
    if (String(url).includes("/api/document/data")) {
      return safeFetchStyleResponse(JSON.stringify({ status: 0, isSuccess: true, data: { documentContent: packageSample() } }));
    }
    // safeFetch 把多条 set-cookie join(", ")——验证「逗号+name=」启发式拆分与 jar 合并
    return safeFetchStyleResponse('{"dentryKey":"nmbmj1wmconnN80l"}', "XSRF-TOKEN=abc; Path=/, cna=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT, visitor=9; Domain=.dingtalk.com");
  };
  const doc = await extractDingtalkDoc("https://alidocs.dingtalk.com/i/nodes/gpG2NdyVX3mmZxQYHA1AGnXAWMwvDqPk", {
    webSessionManager: { collectCookies: async () => "" },
    fetchImpl,
  });
  assert.equal(doc.title, "测试文档");
  assert.ok(doc.html.includes("标题一"));
  assert.equal(seen.length, 2);
  // jar 合并了匿名访客 cookie:POST 与图片下载都带上
  assert.ok(seen[1].includes("api/document/data"));
  assert.match(doc.imageHeaders.cookie, /XSRF-TOKEN=abc/);
  assert.match(doc.imageHeaders.cookie, /cna=xyz/);
  assert.match(doc.imageHeaders.cookie, /visitor=9/);
  assert.equal(doc.imageHeaders["a-dentry-key"], "nmbmj1wmconnN80l");
});
