"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const {
  WebClipper, articleFromHtml, bestSrcset, cleanMarkdown, detectCommunityPage, escapeWebText,
  isLikelyContentImage, nodeToMarkdown, prepareDocument, selectArticle, wechatArticleIdentityUrl,
} = require("../src/core/webclip");
const { decodeHtmlBuffer } = require("../src/core/network");
const { safeFileName } = require("../src/core/util");

test("HTML buffers decode with the declared GBK charset instead of forcing UTF-8", () => {
  // "测试" in GBK is B2 E2 CA D4; force-decoding those bytes as UTF-8 garbles them.
  const gbkBytes = Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0xb2, 0xe2, 0xca, 0xd4, 0x3c, 0x2f, 0x68, 0x31, 0x3e]); // <h1>...</h1>
  const metaHtml = Buffer.concat([
    Buffer.from('<!doctype html><html><head><meta charset="gb2312"></head><body>'),
    gbkBytes,
  ]);
  assert.equal(decodeHtmlBuffer(metaHtml, "text/html"), "<!doctype html><html><head><meta charset=\"gb2312\"></head><body><h1>测试</h1>");
  assert.equal(decodeHtmlBuffer(gbkBytes, "text/html; charset=GBK"), "<h1>测试</h1>");
  // No declaration anywhere: UTF-8 replacement density triggers legacy-charset sniffing.
  assert.equal(decodeHtmlBuffer(gbkBytes, "text/html"), "<h1>测试</h1>");
  const utf8 = Buffer.from("<h1>测试</h1>", "utf8");
  assert.equal(decodeHtmlBuffer(utf8, "text/html"), "<h1>测试</h1>");
});

test("safe file names strip replacement chars and lone surrogates but keep emoji", () => {
  const cleaned = safeFileName("bad\uFFFD\uFFFDtitle \uD800lonely");
  assert.doesNotMatch(cleaned, /[\uFFFD]/);
  assert.doesNotMatch(cleaned, /[\uD800-\uDFFF]/);
  assert.match(cleaned, /badtitle lonely/);
  assert.match(safeFileName("apple 🍏 pie"), /apple 🍏 pie/);
});

test("safe file names drop code points macOS APFS refuses (U+07BE and friends)", () => {
  const { writeFileSync, unlinkSync, existsSync } = require("node:fs");
  const name = safeFileName("ʲ이-ͼ20260914ƾڷ\u07BE");
  assert.doesNotMatch(name, /\u07BE/);
  // The whole point: the cleaned name must be openable on this filesystem.
  const probe = `/tmp/eilseq-guard-${name}.txt`;
  writeFileSync(probe, "x");
  assert.ok(existsSync(probe));
  unlinkSync(probe);
});

test("article extraction survives malformed and parser-hostile HTML without throwing", () => {
  const hostile = [
    '<!doctype html><html><body><table><tr><td><div><script>document.write("<div>")</script>',
    '<bili-header><bili-toolbar></bili-toolbar></bili-header>',
    '<svg><foreignObject><div><span>nested',
    '<p class="video-title">B站视频标题'.repeat(40) + "正文内容需要足够长以便阅读算法识别为文章主体。".repeat(20),
    '</td></tr></table></body>',
  ].join("");
  const article = articleFromHtml(hostile, "https://www.bilibili.com/video/BV1Dve565ENK/");
  assert.ok(article);
  assert.ok(["readability", "document-body"].includes(article.extractionMethod));
  assert.ok(String(article.title || "").length > 0);
});

test("lazy images and relative links become absolute before extraction", () => {
  const { document } = parseHTML('<!doctype html><html><body><a href="/next">next</a><img data-src="/photo.jpg"><script>bad()</script></body></html>');
  prepareDocument(document, "https://example.com/posts/one");
  assert.equal(document.querySelector("a").getAttribute("href"), "https://example.com/next");
  assert.equal(document.querySelector("img").getAttribute("src"), "https://example.com/photo.jpg");
  assert.equal(document.querySelector("script"), null);
});

test("markdown conversion preserves headings, links, lists, and images", () => {
  const { document } = parseHTML('<!doctype html><html><body><h1>Title</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li></ul><img src="https://example.com/a.png" alt="A"></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /## Title/);
  assert.match(markdown, /Hello \*\*world\*\*/);
  assert.match(markdown, /- One/);
  assert.match(markdown, /!\[A\]\(<https:\/\/example.com\/a.png>\)/);
});

test("Feishu virtual document block types retain headings, lists, quotes, and dividers", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div data-block-type="heading2"><div>Section</div></div>
    <div data-block-type="bullet"><div>Bullet item</div></div>
    <div data-block-type="ordered"><div>2. Ordered item</div></div>
    <div data-block-type="quote_container"><div>Quoted text</div></div>
    <div data-block-type="divider"></div>
  </body></html>`);
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /^### Section$/m);
  assert.match(markdown, /^- Bullet item$/m);
  assert.match(markdown, /^1\. Ordered item$/m);
  assert.match(markdown, /^> Quoted text$/m);
  assert.match(markdown, /^---$/m);
});

test("web text cannot become Obsidian embeds, comments, HTML, or executable fenced blocks", () => {
  const { document } = parseHTML('<!doctype html><html><body><p>![[Private note]] [[Wiki]] %% hidden %% &lt;iframe src="bad"&gt;</p><p>```dataviewjs</p><p>dv.pages()</p></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.doesNotMatch(markdown, /(^|[^\\])!\[\[/);
  assert.doesNotMatch(markdown, /(^|[^\\])\[\[/);
  assert.doesNotMatch(markdown, /(^|[^\\])%%/);
  assert.doesNotMatch(markdown, /<iframe/i);
  assert.doesNotMatch(markdown, /^```dataviewjs/m);
  assert.match(markdown, /\\!\\\[/);
  assert.match(escapeWebText("1. item"), /^1\\\. item$/);
});

test("code indentation, blank lines, and nested list depth survive Markdown cleanup", () => {
  const { document } = parseHTML('<!doctype html><html><body><pre>if ready:\n    run()\n\n    finish()</pre><ul><li>Parent<ul><li>Child<ol start="3"><li>Third</li></ol></li></ul></li></ul></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /if ready:\n    run\(\)\n\n    finish\(\)/);
  assert.match(markdown, /^- Parent$/m);
  assert.match(markdown, /^  - Child$/m);
  assert.match(markdown, /^    3\. Third$/m);
});

test("srcset chooses the largest listed candidate", () => {
  assert.equal(bestSrcset("small.jpg 320w, large.jpg 1280w"), "large.jpg");
});

test("tiny decorative logos are excluded while article images remain", () => {
  const { document } = parseHTML('<!doctype html><html><body><img id="logo" src="https://cdn.example/60px-Commons-logo.svg.png"><img id="photo" src="https://cdn.example/1200px-landscape.jpg"></body></html>');
  assert.equal(isLikelyContentImage(document.querySelector("#logo")), false);
  assert.equal(isLikelyContentImage(document.querySelector("#photo")), true);
});

test("WeChat articles use js_content instead of script-heavy Readability input", () => {
  const filler = "这是微信公众号正文。".repeat(30);
  const { document } = parseHTML(`<!doctype html><html><head><meta name="author" content="作者甲"></head><body><script>${"noise ".repeat(2000)}</script><h1 id="activity-name">文章标题</h1><a id="js_name">测试公众号</a><div id="js_content"><p>${filler}</p><img data-src="/article.jpg"></div></body></html>`);
  prepareDocument(document, "https://mp.weixin.qq.com/s/example");
  const article = selectArticle(document, "https://mp.weixin.qq.com/s/example");
  assert.equal(article.extractionMethod, "wechat-article");
  assert.equal(article.title, "文章标题");
  assert.equal(article.byline, "作者甲");
  assert.equal(article.siteName, "测试公众号");
  assert.match(article.content, /这是微信公众号正文/);
  assert.match(article.content, /https:\/\/mp\.weixin\.qq\.com\/article\.jpg/);
});

test("WeChat extraction removes page chrome, normalizes titles, records publish time, and keeps a stable identity", () => {
  const html = `<!doctype html><html><head><link rel="canonical" href="https://mp.weixin.qq.com/s/short-id"></head><body>
    <script>var biz = "" || "MzA1234"; var mid = "123456789"; var idx = "2"; var createTime = 1700000000; var bait = "__biz=" + biz + "&mid=";</script>
    <h1 id="activity-name">First\n  title</h1><div id="js_content"><p>${"Article body. ".repeat(20)}</p><div class="rich_media_tool">Scan with WeChat</div></div>
  </body></html>`;
  const article = articleFromHtml(html, "https://mp.weixin.qq.com/s/short-id?scene=1");
  assert.equal(article.title, "First title");
  assert.equal(article.identityUrl, "https://mp.weixin.qq.com/s?__biz=MzA1234&mid=123456789&idx=2");
  assert.equal(article.publishedAt, "2023-11-14T22:13:20.000Z");
  assert.doesNotMatch(article.markdown, /Scan with WeChat/);
});

test("WeChat long URLs ignore volatile parameters and match short links when page identity is available", () => {
  const html = '<script>\nvar biz = "" || "MzB5678";\nvar mid = "987654321";\nvar idx = "1";\nvar bait = "__biz=" + biz + "&mid=";\n</script>';
  const longA = "https://mp.weixin.qq.com/s?__biz=MzB5678&mid=987654321&idx=1&chksm=aaa&scene=1";
  const longB = "https://mp.weixin.qq.com/s?scene=9&idx=1&mid=987654321&__biz=MzB5678&chksm=bbb";
  const short = "https://mp.weixin.qq.com/s/another-short-id";
  assert.equal(wechatArticleIdentityUrl(html, longA), wechatArticleIdentityUrl(html, longB));
  assert.equal(wechatArticleIdentityUrl(html, short), wechatArticleIdentityUrl(html, longA));
});

test("web image localization is concurrent, bounded, and reuses the stable clipping path", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: true, maxFileMb: 20, maxWebImages: 3, maxWebImageTotalMb: 1, webClipBudgetSeconds: 75 },
  };
  let existingPath = "";
  let active = 0;
  let peak = 0;
  const writes = [];
  const writer = {
    findTextBySuffix: () => existingPath,
    saveBinary: async (folder, name) => `${folder}/${name}.png`,
    upsertText: async (path, content) => { existingPath = path; writes.push({ path, content }); },
  };
  const clipper = new WebClipper(writer, settings, {
    download: async (_url, options) => {
      assert.equal(options.timeoutMs <= 10_000, true);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { buffer: Buffer.alloc(400 * 1024), mimeType: "image/png", fileName: "image" };
    },
  });
  const article = {
    url: "https://example.com/post?utm_source=test",
    identityUrl: "https://example.com/post",
    title: "Example",
    siteName: "Example",
    byline: "",
    markdown: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.png`).join("\n"),
    images: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.png`),
    extractionMethod: "test",
    extractionStatus: "complete",
  };
  const first = await clipper.saveArticle(article, { timestamp: new Date("2026-08-31T00:00:00Z") });
  const second = await clipper.saveArticle(article, { timestamp: new Date("2026-09-01T00:00:00Z") });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.notePath, first.notePath);
  assert.equal(first.savedImages, 2);
  assert.equal(first.imageFailures.length, 3);
  assert.equal(peak > 1 && peak <= 4, true);
  assert.equal(writes.length, 2);
});

test("unknown forum engines and generic comment markup receive a conversation fallback", () => {
  const html = `<!doctype html><html><head><meta name="generator" content="Flarum"></head><body><main><article><h1>Extensible forum</h1><p>${"Main technical discussion. ".repeat(12)}</p></article><div class="comment"><strong>Alice</strong><p>First useful reply with enough detail.</p></div><div class="comment"><strong>Bob</strong><p>Second useful reply with another perspective.</p></div></main></body></html>`;
  assert.equal(detectCommunityPage(html, "https://forum.example.org/d/123"), true);
  const article = articleFromHtml(html, "https://forum.example.org/d/123");
  assert.equal(article.commentCount, 2);
  assert.match(article.extractionMethod, /with-comments/);
  assert.match(article.markdown, /First useful reply/);
});

function xhsTestSettings() {
  return {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { renderDynamicPages: true, webClipBudgetSeconds: 75, downloadWebImages: false },
  };
}

function xhsNoteHtml() {
  const state = `{"note":{"currentNoteId":"note123","noteDetailMap":{"note123":{"note":{"noteId":"note123","title":"A useful note","desc":"First line\\nSecond line with enough useful text to save, padded past the completeness threshold for tests.","time":1788253336000,"user":{"nickname":"Alice"},"imageList":[]}}}}}`;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${state}</script></body></html>`;
}

function fakeHtmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: (async function* () { yield Buffer.from(String(html || "")); })(),
  };
}

test("Xiaohongshu note pages surface the real error instead of falling back to a browser session", async () => {
  const sessionCalls = [];
  const clipper = new WebClipper({}, xhsTestSettings(), {
    fetch: async () => { throw new Error("network down"); },
    sessionManager: { extract: async (...args) => { sessionCalls.push(args); return { html: "", url: "", title: "", text: "" }; } },
  });
  await assert.rejects(clipper.extract("https://xhslink.cn/o/8MV5eiZ7OR9"), /network down/);
  assert.equal(sessionCalls.length, 0);
});

test("Xiaohongshu notes clip through the injected fetch without browser sessions", async () => {
  const sessionCalls = [];
  const clipper = new WebClipper({}, xhsTestSettings(), {
    fetch: async () => ({
      response: fakeHtmlResponse(xhsNoteHtml()),
      finalUrl: "https://www.xiaohongshu.com/explore/note123?xsec_token=temporary",
    }),
    sessionManager: { extract: async (...args) => { sessionCalls.push(args); return { html: "", url: "", title: "", text: "" }; } },
  });
  const article = await clipper.extract("https://xhslink.cn/o/8MV5eiZ7OR9");
  assert.equal(article.title, "A useful note");
  assert.equal(article.extractionMethod, "xiaohongshu-initial-state");
  assert.equal(article.extractionStatus, "complete");
  assert.equal(sessionCalls.length, 0);
});

function zhihuTestSettings() {
  return { storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" }, capture: { renderDynamicPages: true, webClipBudgetSeconds: 75, downloadWebImages: false } };
}

function zhihuAnswerHtml() {
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
            content: `<p>${"关键是要带 cookie 才能通过知乎的风控,回答正文需要足够长。".repeat(5)}</p>`,
            createdTime: 1700000000,
            voteupCount: 12,
          },
        },
      },
    },
  };
  const json = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!doctype html><html><head></head><body><script id="js-initialData" type="text/json">${json}</script></body></html>`;
}

test("Zhihu answers clip through the injected fetch and cookie bridge without browser sessions", async () => {
  const sessionCalls = [];
  const cookieCalls = [];
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    fetch: async () => ({
      response: fakeHtmlResponse(zhihuAnswerHtml()),
      finalUrl: "https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373",
    }),
    sessionManager: {
      collectCookies: async (service, warmupUrl) => { cookieCalls.push([service, warmupUrl]); return ""; },
      extract: async (...args) => { sessionCalls.push(args); return { html: "", url: "", title: "", text: "" }; },
    },
  });
  const article = await clipper.extract("https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373?share_code=x");
  assert.equal(article.title, "如何优雅地抓取知乎回答?");
  assert.equal(article.extractionMethod, "zhihu-initial-state");
  assert.equal(article.extractionStatus, "complete");
  assert.equal(article.siteName, "知乎");
  assert.equal(sessionCalls.length, 0);
  assert.equal(cookieCalls.length, 0);
});

test("Zhihu pages keep the browser-session fallback when HTTP extraction fails", async () => {
  const sessionCalls = [];
  const rendered = {
    html: `<!doctype html><html><body><div class="QuestionHeader-title">渲染路径的问题</div><div class="RichContent-inner"><p>${"浏览器会话渲染出的回答正文,长度需要超过完整性阈值。".repeat(6)}</p></div></body></html>`,
    url: "https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373",
    title: "渲染路径的问题",
    author: "赵六",
    text: "浏览器会话渲染出的回答正文,长度需要超过完整性阈值。".repeat(6),
  };
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    fetch: async () => ({ response: fakeHtmlResponse("", 403), finalUrl: rendered.url }),
    sessionManager: {
      collectCookies: async () => "",
      extract: async (...args) => { sessionCalls.push(args); return rendered; },
    },
  });
  const article = await clipper.extract("https://www.zhihu.com/question/1951716962645288920/answer/2035816979085390373");
  assert.equal(sessionCalls.length, 1);
  assert.equal(sessionCalls[0][1], "zhihu");
  assert.equal(article.extractionStatus, "complete");
  assert.match(article.extractionMethod, /zhihu-rendered/);
});

test("the session-cookie bridge passes the site-specific refresh parameters", async () => {
  const cookieOptions = [];
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    sessionManager: { collectCookies: async (service, warmupUrl, options) => { cookieOptions.push([service, warmupUrl, options]); return "d_c0=x"; } },
  });
  const cookieHeader = await clipper.collectSessionCookies("zhihu", "https://www.zhihu.com/question/1/answer/2");
  assert.equal(cookieHeader, "d_c0=x");
  assert.equal(cookieOptions[0][0], "zhihu");
  assert.equal(cookieOptions[0][1], "https://www.zhihu.com/question/1/answer/2");
  assert.equal(cookieOptions[0][2].requiredCookie, "__zse_ck");
  assert.equal(cookieOptions[0][2].fallbackUrl, "https://www.zhihu.com/explore");
});

test("stealth evasions ship as a non-empty bundled script", () => {
  const stealthScript = require("../src/core/stealth-script");
  assert.equal(typeof stealthScript, "string");
  assert.ok(stealthScript.length > 10_000);
  assert.doesNotMatch(stealthScript, /HeadlessChrome/);
});
