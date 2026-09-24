"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const {
  WebClipper, articleFromHtml, bestSrcset, cleanMarkdown, detectCommunityPage, escapeWebText,
  isLikelyContentImage, nodeToMarkdown, prepareDocument, selectArticle, sourceArticle, wechatArticleIdentityUrl,
} = require("../src/clip/webclip");
const { decodeHtmlBuffer } = require("../src/core/network");
const { isWeixinSphUrl } = require("../src/clip/social-media/weixinclip");
const { localIso, safeFileName } = require("../src/core/util");

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
  assert.equal(cleaned, "badtitlelonely");
  assert.equal(safeFileName("apple 🍏 pie"), "apple🍏pie");
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

test("Feishu virtual document block types retain headings, lists, quotes, code, and dividers", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div data-block-type="heading2"><div>Section</div></div>
    <div data-block-type="bullet"><div>Bullet item</div></div>
    <div data-block-type="ordered"><div>2. Ordered item</div></div>
    <div data-block-type="quote_container"><div>Quoted text</div></div>
    <div data-block-type="divider"></div>
    <div data-block-type="code">
      <div data-block-type="code_line"><span>const ready = true;</span></div>
      <div data-block-type="code_line"><span>  if (ready) {</span></div>
      <div data-block-type="code_line"><span>    run();</span></div>
      <div data-block-type="code_line"><span>  }</span></div>
    </div>
  </body></html>`);
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /^### Section$/m);
  assert.match(markdown, /^- Bullet item$/m);
  assert.match(markdown, /^1\. Ordered item$/m);
  assert.match(markdown, /^> Quoted text$/m);
  assert.match(markdown, /^---$/m);
  // 代码块保留围栏与行内缩进,行不被拍平成段落
  assert.match(markdown, /```(?:\w*)\nconst ready = true;\n  if \(ready\) \{\n    run\(\);\n  \}\n```/);
});

test("Feishu code blocks rendered without line elements split on zero-width separators", () => {
  const { document } = parseHTML(`<!doctype html><html><body><div data-block-type="code"><div>代码块\u200BPlain Text 自动换行复制before_tool_call(event, ctx):\u200B  ├─ au 未安装 → return\u200B  └─ done</div></div></body></html>`);
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  // fencedCode 最少输出四反引号围栏(与钉钉产物一致)
  assert.match(markdown, /````\nbefore_tool_call\(event, ctx\):\n  ├─ au 未安装 → return\n  └─ done\n````/);
  assert.doesNotMatch(markdown, /自动换行复制/);
  assert.doesNotMatch(markdown, /代码块/);
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

test("data URI svg interface icons are not treated as content images", () => {
  const { document } = parseHTML('<!doctype html><html><body><img id="crumb" src="data:image/svg+xml,%3csvg%20width=\'16\'%3e"><img id="real" src="https://cdn.example/pic.png"></body></html>');
  assert.equal(isLikelyContentImage(document.querySelector("#crumb")), false);
  assert.equal(isLikelyContentImage(document.querySelector("#real")), true);
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
  assert.equal(article.publishedAt, localIso(new Date(1700000000000)));
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
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
    capture: { downloadWebImages: true, maxFileMb: 20, maxWebImages: 3, webClipBudgetSeconds: 75 },
  };
  let existingPath = "";
  let active = 0;
  let peak = 0;
  const writes = [];
  const trashed = [];
  const writer = {
    findTextBySuffix: () => existingPath,
    saveBinary: async (folder, name) => `${folder}/${name}.png`,
    upsertText: async (path, content) => { existingPath = path; writes.push({ path, content }); },
    readText: async (path) => writes.find((w) => w.path === path)?.content || "",
    trashFile: async (path) => { trashed.push(path); return true; },
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
    markdown: Array.from({ length: 5 }, (_, index) => `![](https://img.example/${index}.png)`).join("\n"),
    images: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.png`),
    extractionMethod: "test",
    extractionStatus: "complete",
  };
  const first = await clipper.saveArticle(article, { timestamp: new Date("2026-08-31T00:00:00Z") });
  const second = await clipper.saveArticle(article, { timestamp: new Date("2026-09-01T00:00:00Z") });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  // 同链接重剪:写入当天新路径,旧文件与旧本地图移入回收站
  assert.notEqual(second.notePath, first.notePath);
  assert.match(first.notePath, /2026-08-31/);
  assert.match(second.notePath, /2026-09-01/);
  assert.equal(first.savedImages, 3);
  // 第 4、5 张超出 maxWebImages=3 上限(保留原链);总量预算已移除,单文件 400KB 均在 maxFileMb 内
  assert.equal(first.imageSkipped.length, 2);
  assert.equal(first.imageFailures.length, 0);
  assert.equal(peak > 1 && peak <= 4, true);
  assert.equal(writes.length, 2);
  assert.ok(trashed.includes(first.notePath));
  const oldImages = trashed.filter((p) => p.startsWith("Omnichannel Diary/Attachments/Web/2026-08-31/"));
  assert.equal(oldImages.length, 3);
  assert.equal(trashed.includes(second.notePath), false);
});

test("web video download is opt-in, replaces the link, and degrades softly", async () => {
  const baseSettings = (over = {}) => ({
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
    capture: { downloadWebImages: false, maxFileMb: 20, maxWebImages: 3, webClipBudgetSeconds: 75, ...over },
  });
  const writer = {
    findTextBySuffix: () => "",
    saveBinary: async (folder, name, buffer, mime) => `${folder}/${name}${mime === "video/mp4" ? ".mp4" : ".bin"}`,
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const videoArticle = (videoUrl) => ({
    url: "https://www.xiaohongshu.com/explore/noteV",
    identityUrl: "https://www.xiaohongshu.com/explore/noteV",
    title: "Video note",
    siteName: "小红书 / REDnote",
    byline: "Alice",
    markdown: `[视频](${videoUrl})`,
    images: [],
    videoUrls: [videoUrl],
    extractionMethod: "xiaohongshu-initial-state",
    extractionStatus: "complete",
  });
  const writes = [];

  // ① 默认关闭:不发起视频下载,链接原样保留
  let videoDownloads = 0;
  const off = new WebClipper(writer, baseSettings(), {
    download: async () => { videoDownloads += 1; return { buffer: Buffer.alloc(8), mimeType: "video/mp4", fileName: "v" }; },
  });
  const offResult = await off.saveArticle(videoArticle("https://sns-video-qc.xhscdn.com/v.mp4?sign=1"), { timestamp: new Date("2026-09-23T00:00:00Z") });
  assert.equal(videoDownloads, 0);
  assert.match(writes.at(-1).content, /https:\/\/sns-video-qc\.xhscdn\.com\/v\.mp4\?sign=1/);

  // ② 开启+下载成功:正文链接替换为本地 mp4
  const on = new WebClipper(writer, baseSettings({ downloadWebVideos: true, maxVideoMb: 100 }), {
    download: async (url, opts) => { videoDownloads += 1; return { buffer: Buffer.alloc(1024), mimeType: "video/mp4", fileName: opts.fileName }; },
  });
  const onResult = await on.saveArticle(videoArticle("https://sns-video-qc.xhscdn.com/v2.mp4?sign=2"), { timestamp: new Date("2026-09-23T00:00:00Z") });
  assert.equal(videoDownloads, 1);
  assert.match(writes.at(-1).content, /Attachments\/Web\/2026-09-23\/.*-video-01\.mp4/);
  assert.doesNotMatch(writes.at(-1).content, /sign=2/);
  assert.doesNotMatch(writes.at(-1).content, /未保存/);

  // ③ 超过单个视频上限:软降级,保留远程链接并 warning(文案带数组序号)
  const over = new WebClipper(writer, baseSettings({ downloadWebVideos: true, maxVideoMb: 1 }), {
    download: async () => { videoDownloads += 1; const e = new Error("Remote file exceeds 1048576 bytes"); throw e; },
  });
  const overResult = await over.saveArticle(videoArticle("https://sns-video-qc.xhscdn.com/v3.mp4?sign=3"), { timestamp: new Date("2026-09-23T00:00:00Z") });
  assert.equal(videoDownloads, 2);
  assert.match(writes.at(-1).content, /视频-01 未保存/);
  assert.match(writes.at(-1).content, /https:\/\/sns-video-qc\.xhscdn\.com\/v3\.mp4\?sign=3/);

});

test("downloads each video with indexed names and isolates failures", async () => {
  const baseSettings = (over = {}) => ({
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
    capture: { downloadWebImages: false, maxFileMb: 20, maxWebImages: 3, webClipBudgetSeconds: 75, ...over },
  });
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    saveBinary: async (folder, name) => `Attachments/Web/2026-09-23/${name}.mp4`,
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const first = "https://cdn.example.com/broken.mp4";
  const second = "https://cdn.example.com/ok.mp4";
  const clipper = new WebClipper(writer, baseSettings({ downloadWebVideos: true, maxVideoMb: 100 }), {
    download: async (url, opts) => {
      if (url === first) throw new Error("HTTP 403");
      return { buffer: Buffer.alloc(16), mimeType: "video/mp4", fileName: opts.fileName };
    },
  });
  await clipper.saveArticle({
    url: "https://www.xiaohongshu.com/explore/noteV2",
    identityUrl: "https://www.xiaohongshu.com/explore/noteV2",
    title: "Video note",
    siteName: "小红书 / REDnote",
    byline: "Alice",
    markdown: `[a](${first}) [b](${second})`,
    images: [],
    videoUrls: [first, second],
    extractionMethod: "xiaohongshu-initial-state",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-23T00:00:00Z") });
  const content = writes.at(-1).content;
  // 序号按数组索引:第 1 个失败占号 -01,第 2 个成功仍是 -02
  assert.match(content, /Videonote-video-02\.mp4/);
  assert.doesNotMatch(content, /video-01\.mp4/);
  assert.match(content, /视频-01 未保存\(HTTP 403\)/);
  assert.doesNotMatch(content, /视频-02 未保存/);
  // 失败者保留远程链接,成功者替换为本地路径
  assert.match(content, /https:\/\/cdn\.example\.com\/broken\.mp4/);
  assert.doesNotMatch(content, /https:\/\/cdn\.example\.com\/ok\.mp4/);
});

test("sourceArticle normalizes single value and dedupes videoUrls", () => {
  const base = { title: "T", images: [], extractionStatus: "complete" };
  assert.deepEqual(sourceArticle({ ...base }, { videoUrl: "https://cdn.example.com/a.mp4" }).videoUrls, ["https://cdn.example.com/a.mp4"]);
  assert.deepEqual(sourceArticle({ ...base }, { videoUrls: ["a", "a", "b", ""] }).videoUrls, ["a", "b"]);
  // data 层无视频时保留 article 层兜底产物(C3 衔接),两边都无则为空数组
  assert.deepEqual(sourceArticle({ ...base, videoUrls: ["legacy"] }, {}).videoUrls, ["legacy"]);
  assert.deepEqual(sourceArticle({ ...base }, {}).videoUrls, []);
});

test("same source URL segments replace once and annotate the rest", async () => {
  const baseSettings = (over = {}) => ({
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
    capture: { downloadWebImages: false, maxFileMb: 20, maxWebImages: 3, webClipBudgetSeconds: 75, ...over },
  });
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    saveBinary: async (folder, name) => `Attachments/Web/2026-09-23/${name}.mp4`,
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const seg = "https://cdn.example.com/long-video-seg";
  const clipper = new WebClipper(writer, baseSettings({ downloadWebVideos: true, maxVideoMb: 100 }), {
    download: async (url, opts) => ({ buffer: Buffer.alloc(8), mimeType: "video/mp4", fileName: opts.fileName }),
  });
  await clipper.saveArticle({
    url: "https://www.bilibili.com/video/BV1Dve565ENK",
    identityUrl: "https://www.bilibili.com/video/BV1Dve565ENK",
    title: "Long video",
    siteName: "哔哩哔哩",
    byline: "UP",
    markdown: `[正片](${seg})`,
    images: [],
    videoUrls: [seg, seg],
    extractionMethod: "bilibili-initial-state",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-23T00:00:00Z") });
  const content = writes.at(-1).content;
  // 首段替换正文原链接,第二段以附注列出,不做二次 split 互相覆盖
  assert.match(content, /Attachments\/Web\/2026-09-23\/Longvideo-video-01\.mp4/);
  assert.doesNotMatch(content, /video-01\.mp4\) \[正片\]/);
  assert.match(content, /视频分段-02/);
  assert.match(content, /video-02\.mp4/);
});

test("appends download links for videos absent from the markdown body", async () => {
  const baseSettings = (over = {}) => ({
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
    capture: { downloadWebImages: false, maxFileMb: 20, maxWebImages: 3, webClipBudgetSeconds: 75, ...over },
  });
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    saveBinary: async (folder, name) => `Attachments/Web/2026-09-23/${name}.mp4`,
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const remote = "https://v.vzuu.com/probe.mp4";
  const clipper = new WebClipper(writer, baseSettings({ downloadWebVideos: true, maxVideoMb: 100 }), {
    download: async (url, opts) => ({ buffer: Buffer.alloc(16), mimeType: "video/mp4", fileName: opts.fileName }),
  });
  await clipper.saveArticle({
    url: "https://www.zhihu.com/question/1/answer/2",
    identityUrl: "https://www.zhihu.com/question/1/answer/2",
    title: "ZhihuVideoAnswer",
    siteName: "知乎",
    byline: "答主",
    markdown: "<p>正文没有任何视频链接文本</p>",
    images: [],
    videoUrls: [remote], // C4 渲染探测产出:markdown 原文不含该 URL
    extractionMethod: "zhihu-initial-state",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-23T00:00:00Z") });
  const content = writes.at(-1).content;
  assert.match(content, /ZhihuVideoAnswer-video-01\.mp4/);
  // 正文无原位链接可替换:下载成功后追加引用段,文件不再成为孤儿
  assert.match(content, /- \[视频-01\]\(Attachments\/Web\/2026-09-23\/ZhihuVideoAnswer-video-01\.mp4\)/);
});

test("sina visitor redirect is unwrapped to the real weibo status", async () => {
  const visitorUrl = "https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2Fdetail%2F5346544981377322&domain=.weibo.cn&_rand=1790231896.2583";
  const statusPayload = {
    ok: 1,
    id: "5346544981377322",
    idstr: "5346544981377322",
    created_at: "Wed Sep 23 16:00:27 +0800 2026",
    text: "<p>微博正文内容</p>",
    user: { screen_name: "测试用户" },
  };
  const seenUrls = [];
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    fetch: async (url) => {
      seenUrls.push(String(url));
      return {
        response: {
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          body: (async function* () { yield Buffer.from(JSON.stringify(statusPayload)); })(),
        },
        finalUrl: "",
      };
    },
    sessionManager: { collectCookies: async () => "SUB=_2AkTestCookieValue" },
  });
  const article = await clipper.extract(visitorUrl);
  // 访客壳页被解包:直接按真实链接走微博 statuses/show API,而不是存下 "Sina Visitor System"
  assert.match(seenUrls[0], /api\/statuses\/show\?id=5346544981377322/);
  assert.equal(article.extractionMethod, "weibo-json");
  assert.equal(article.byline, "测试用户");
  assert.equal(article.identityUrl, "weibo-status:5346544981377322");
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
    storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" },
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
  return { storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" }, capture: { renderDynamicPages: true, webClipBudgetSeconds: 75, downloadWebImages: false } };
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

test("Feishu rendered docs bridge session cookies for image localization", async () => {
  const cookieCalls = [];
  const rendered = {
    html: `<!doctype html><html><body><div class="doc-title">AI 鹊桥</div><div class="doc-content"><p>${"飞书会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验。".repeat(6)}</p><p><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/SfM/?preview_type=16"></p></div></body></html>`,
    url: "https://my.feishu.cn/wiki/CEFJwoogJiIRG7kUISbc6JctnJg",
    title: "AI 鹊桥",
    author: "",
    text: "飞书会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验。".repeat(6),
  };
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async () => ({ response: fakeHtmlResponse("", 403), finalUrl: rendered.url }),
    sessionManager: {
      collectCookies: async (service) => { cookieCalls.push(service); return "feishu_session=tok"; },
      extract: async () => rendered,
    },
  });
  const article = await clipper.extract("https://my.feishu.cn/wiki/CEFJwoogJiIRG7kUISbc6JctnJg");
  assert.match(article.extractionMethod, /feishu-rendered/);
  assert.equal(cookieCalls[0], "feishu");
  // 渲染会话的登录 cookie 挂到 imageHeaders,供图片下载透传
  assert.deepEqual(article.imageHeaders, { cookie: "feishu_session=tok" });
  assert.equal(article.images.length, 1);
});

test("feishu memory block map wins over rendered DOM and labels feishu-block-map", async () => {
  const clientvar = JSON.stringify({ data: { block_map: {
    root: { data: { type: "page", children: ["h", "p"] } },
    h: { data: { type: "heading1", children: [], text: { apool: { numToAttrib: {} }, initialAttributedTexts: { attribs: { "0": "" }, text: { "0": "内存块标题" } } } } },
    p: { data: { type: "text", children: [], text: { apool: { numToAttrib: {} }, initialAttributedTexts: { attribs: { "0": "" }, text: { "0": "正文段落,内存直取比虚拟滚动 DOM 完整得多,应当被优先采用作为最终 markdown。" } } } } },
  } } });
  const rendered = {
    // 渲染 DOM 正文很短(虚拟滚动只出首屏),不足以触发 complete,但内存直取应覆盖
    html: `<!doctype html><html><body><div class="doc-content"><p>短</p></div></body></html>`,
    url: "https://my.feishu.cn/docx/KsWjdmlguoa5WCxliKKcpTfXn8N",
    title: "内存块标题", author: "", text: "短", extraValue: clientvar,
  };
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async () => ({ response: fakeHtmlResponse("", 403), finalUrl: rendered.url }),
    sessionManager: { collectCookies: async () => "feishu_session=tok", extract: async () => rendered },
  });
  const article = await clipper.extract("https://my.feishu.cn/docx/KsWjdmlguoa5WCxliKKcpTfXn8N");
  assert.equal(article.extractionMethod, "feishu-block-map");
  assert.equal(article.extractionStatus, "complete");
  assert.match(article.markdown, /## 内存块标题/);
  assert.match(article.markdown, /正文段落/);
  assert.deepEqual(article.imageHeaders, { cookie: "feishu_session=tok" });
});

test("WPS clips through the open/otl API and labels wps-otl", async () => {
  const otl = { content: { type: "logic_block", content: [{ type: "block_tile", content: [
    { type: "outline-title", content: [{ type: "text", text: "外卖红包" }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "美团外卖" }] },
    { type: "paragraph", attrs: {}, content: [{ type: "text", text: "正文内容需要超过六十字符的阈值才会被 WPS 直取分支采用作为最终结果返回给调用方使用。" }] },
  ] }] } };
  const fileInfo = { file: { name: "外卖红包.otl", office_type: "o", create_time: 1747930231, creator: { name: "未命名" } } };
  const fetchCalls = [];
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async (target, init) => {
      fetchCalls.push({ target, method: init?.method });
      if (/\/file\/ck1mE4vgjirr$/.test(target)) return { response: { status: 200, json: async () => fileInfo }, finalUrl: target };
      if (/\/open\/otl$/.test(target)) return { response: { status: 200, json: async () => otl }, finalUrl: target };
      if (/\/attachment\/shapes$/.test(target)) return { response: { status: 200, json: async () => ({ data: {} }) }, finalUrl: target };
      return { response: { status: 200, json: async () => ({}) }, finalUrl: target };
    },
    sessionManager: { collectCookies: async () => "csrf=abc123; s=1", extract: async () => ({ html: "", url: "", text: "" }) },
  });
  const article = await clipper.extract("https://www.kdocs.cn/l/ck1mE4vgjirr");
  assert.equal(article.extractionMethod, "wps-otl");
  assert.equal(article.title, "外卖红包");
  assert.match(article.markdown, /## 美团外卖/);
  // 先 file 接口拿 office_type,再 open/otl
  assert.match(fetchCalls[0].target, /\/file\/ck1mE4vgjirr$/);
  assert.equal(fetchCalls[1].target, "https://www.kdocs.cn/api/v3/office/file/ck1mE4vgjirr/open/otl");
  assert.equal(fetchCalls[1].method, "POST");
  assert.deepEqual(article.imageHeaders, { cookie: "csrf=abc123; s=1" });
});

test("WPS falls back to rendered extraction when open/otl fails", async () => {
  const rendered = {
    html: `<!doctype html><html><body><div class="doc-content"><p>${"WPS 会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验并作为兜底结果。".repeat(5)}</p></div></body></html>`,
    url: "https://www.kdocs.cn/l/ck1mE4vgjirr", title: "外卖红包", author: "",
    text: "WPS 会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验并作为兜底结果。".repeat(5),
  };
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    // open/otl 返回 401 → extractWpsDoc 抛错 → 回落渲染
    fetch: async () => ({ response: { status: 401, json: async () => ({}) }, finalUrl: rendered.url }),
    sessionManager: { collectCookies: async () => "csrf=abc", extract: async () => rendered },
  });
  const article = await clipper.extract("https://www.kdocs.cn/l/ck1mE4vgjirr");
  assert.match(article.extractionMethod, /wps-rendered/);
  assert.match(article.markdown, /WPS 会话渲染出的文档正文/);
});

test("WPS binary document (et/wps/wpp) downloads as attachment via download_url", async () => {
  const fileInfo = { file: { name: "表格.xls", office_type: "s", create_time: 1788759635, creator: { name: "WPS_user" } } };
  const dlResp = { download_url: "https://cdn.wps.cn/dl/tableau.xls", url: "https://cdn.wps.cn/dl/tableau.xls" };
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async (target) => {
      if (/\/file\/chFxPtxBbEk3$/.test(target)) return { response: { status: 200, json: async () => fileInfo }, finalUrl: target };
      if (/\/download$/.test(target)) return { response: { status: 200, json: async () => dlResp }, finalUrl: target };
      return { response: { status: 200, json: async () => ({}) }, finalUrl: target };
    },
    download: async () => ({ buffer: Buffer.from("fake-xls-content"), fileName: "表格.xls", mimeType: "application/vnd.ms-excel" }),
    sessionManager: { collectCookies: async () => "csrf=abc", extract: async () => ({ html: "", url: "", text: "" }) },
  });
  const article = await clipper.extract("https://www.kdocs.cn/l/chFxPtxBbEk3");
  assert.equal(article.extractionMethod, "wps-file-attachment");
  assert.equal(article.title, "表格.xls");
  assert.equal(article.byline, "WPS_user");
  assert.equal(article.markdown, "");
  assert.equal(article.binaryFiles.length, 1);
  assert.equal(article.binaryFiles[0].fileName, "表格.xls");
  assert.equal(article.binaryFiles[0].mimeType, "application/vnd.ms-excel");
  assert.match(article.publishedAt, /^2026-/);
});

test("WPS login redirect page surfaces DOCUMENT_LOGIN_REQUIRED instead of clipping the login shell", async () => {
  const loginUrl = "https://account.kdocs.cn/passport/singlesign?cb=https%3A%2F%2Fwww.kdocs.cn%2Fl%2FcmWNSE8HVadT&appid=375024576&f=c";
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async () => ({ response: fakeHtmlResponse("<html>登录页</html>"), finalUrl: loginUrl }),
    sessionManager: { collectCookies: async () => "", extract: async () => ({ html: "", url: "", text: "" }) },
  });
  await assert.rejects(
    clipper.extract(loginUrl),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED" && /WPS文档页面需要登录/.test(error.message) && /cmWNSE8HVadT/.test(error.message),
  );
});

test("WPS document without login surfaces DOCUMENT_LOGIN_REQUIRED when rendered content is too short", async () => {
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    // OTL 401(无会话)→ 回退渲染 → 渲染拿到登录页(正文过短)→ 应抛登录引导
    fetch: async () => ({ response: { status: 401, json: async () => ({}) }, finalUrl: "https://www.kdocs.cn/l/cmWNSE8HVadT" }),
    sessionManager: { collectCookies: async () => "", extract: async () => ({ html: "<html>登录</html>", url: "https://www.kdocs.cn/l/cmWNSE8HVadT", text: "登录" }) },
  });
  await assert.rejects(
    clipper.extract("https://www.kdocs.cn/l/cmWNSE8HVadT"),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED" && /WPS文档/.test(error.message),
  );
});

test("tencent canvas fallback that only yields a11y help text degrades to an honest partial", async () => {
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    // 导出链与 opendoc 全失败(无会话)→ 渲染兜底只剩无障碍帮助文本(≥120 字符被判 complete)
    // → C8 质量门命中:丢弃噪声正文,诚实降级 partial
    fetch: async () => ({ response: { status: 401, json: async () => ({}) }, finalUrl: "https://docs.qq.com/sheet/DQVZZn09" }),
    sessionManager: {
      collectCookies: async () => "",
      extract: async () => ({
        html: `<html><body><main>${"欢迎使用腾讯文档。请按 Cmd+Opt+SHIFT 切换到表格内容区。重新听取帮助,收听文档内容。".repeat(4)}</main></body></html>`,
        url: "https://docs.qq.com/sheet/DQVZZn09",
        text: "欢迎使用腾讯文档。请按 Cmd+Opt+SHIFT 切换到表格内容区。重新听取帮助,收听文档内容。".repeat(4),
      }),
    },
  });
  const article = await clipper.extract("https://docs.qq.com/sheet/DQVZZn09");
  assert.equal(article.extractionStatus, "partial");
  assert.equal(article.markdown, "");
  assert.equal(article.contentChars, 0);
  assert.match(article.excerpt, /表格内容需在腾讯文档中查看/);
});

test("feishu rendered payload forwards author and publishedTime into the article", async () => {
  const rendered = {
    html: `<!doctype html><html><body><div class="doc-content"><p>${"飞书会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验。".repeat(6)}</p></div></body></html>`,
    url: "https://my.feishu.cn/wiki/CEFJwoogJiIRG7kUISbc6JctnJg",
    title: "AI 鹊桥",
    author: "张三",
    publishedTime: "2026-09-18 10:00",
    text: "飞书会话渲染出的文档正文,长度需要超过完整性阈值才能通过校验。".repeat(6),
  };
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async () => ({ response: fakeHtmlResponse("", 403), finalUrl: rendered.url }),
    sessionManager: {
      collectCookies: async () => "feishu_session=tok",
      extract: async () => rendered,
    },
  });
  const article = await clipper.extract("https://my.feishu.cn/wiki/CEFJwoogJiIRG7kUISbc6JctnJg");
  assert.equal(article.byline, "张三");
  assert.equal(article.publishedAt, localIso(new Date(2026, 8, 18, 10, 0)));
  assert.deepEqual(article.imageHeaders, { cookie: "feishu_session=tok" });
});

test("feishu file links download the binary as an attachment instead of extracting content", async () => {
  const savedBinaries = [];
  const downloadCalls = [];
  const writer = {
    findTextBySuffix: () => "",
    saveBinary: async (folder, name, buffer, mimeType) => { savedBinaries.push({ folder, name, buffer, mimeType }); return `${folder}/${name}`; },
    upsertText: async (path, content) => { writes.push({ path, content }); return path; },
  };
  const writes = [];
  const clipper = new WebClipper(writer, dingtalkTestSettings(), {
    fetch: async () => { throw new Error("file links should not fall back to HTTP extraction"); },
    sessionManager: { collectCookies: async () => "session=tok; _csrf_token=csrf-1" },
    download: async (url, options) => {
      downloadCalls.push({ url, options });
      return { buffer: Buffer.from("PDFDATA"), mimeType: "application/pdf", fileName: "设计稿.pdf" };
    },
  });
  const article = await clipper.extract("https://my.feishu.cn/file/NOU6bPeNfoKwPbxZDPlcQ0InnL4");
  assert.equal(article.extractionMethod, "feishu-file-attachment");
  assert.equal(article.title, "设计稿.pdf");
  assert.equal(article.binaryFiles.length, 1);
  assert.equal(downloadCalls[0].url.includes("download/preview/NOU6bPeNfoKwPbxZDPlcQ0InnL4?mount_point=explorer&preview_type=16"), true);
  assert.equal(downloadCalls[0].url.includes("version="), false);
  assert.equal(downloadCalls[0].options.headers["x-csrftoken"], "csrf-1");
  assert.equal(downloadCalls[0].options.headers["x-command"], "stream.download.preview");
  await clipper.saveArticle(article, { timestamp: new Date("2026-09-20T00:00:00Z") });
  assert.equal(savedBinaries[0].name, "设计稿.pdf");
  assert.equal(savedBinaries[0].mimeType, "application/pdf");
  assert.match(writes[0].content, /设计稿\.pdf/);
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
  const stealthScript = require("../src/clip/lib/stealth-script");
  assert.equal(typeof stealthScript, "string");
  assert.ok(stealthScript.length > 10_000);
  assert.doesNotMatch(stealthScript, /HeadlessChrome/);
});

function dingtalkTestSettings() {
  return { storage: { rootFolder: "Omnichannel Diary", clippingFolder: "Clippings", chatAttachmentFolder: "Attachments/Chat", webAttachmentFolder: "Attachments/Web" }, capture: { renderDynamicPages: true, webClipBudgetSeconds: 75, downloadWebImages: true } };
}

function dingtalkPackageJson() {
  return JSON.stringify({
    fileMetaInfo: { name: "新人百宝箱", creator: { nick: "张三" }, gmtCreate: 1700000000000 },
    parts: { main: { data: { body: ["root", {},
      ["h1", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "欢迎标题"]]],
      ["p", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "私有文档正文需要写足够长的内容以通过完整性校验,这里是钉钉文档 API 直取的正文样本。".repeat(3)]]],
      ["p", {}, ["img", { "src": "https://down.dingtalk.com/ddmedia/welcome.png", "alt": "欢迎图片" }]],
      ["p", {}, ["img", { "src": "/core/api/resources/img/5eecdaf48460cde5b35547b8056687dd6f438ca4bd5a4c8dc1b0aaf4285a4450cf9289de50d8305639e8703ac5556d0d" }]],
      ["code", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, "DOC_ENGINE=elasticsearch\nSTACK_VERSION=8.11.3"]]],
    ] } } },
  });
}

test("DingTalk doc pages clip through the document/data API with session cookies", async () => {
  const cookieCalls = [];
  const seen = [];
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async (url, options = {}) => {
      seen.push({ url: String(url), headers: options.headers || {} });
      if (String(url).includes("/api/document/data")) {
        return { response: { ok: true, status: 200, json: async () => ({ status: 0, isSuccess: true, data: { documentContent: dingtalkPackageJson() } }) } };
      }
      return { response: { ok: true, status: 200, text: async () => '{"dentryKey":"nmbmj1wmconnN80l"}' } };
    },
    sessionManager: {
      collectCookies: async (service) => { cookieCalls.push(service); return "doc_atoken=tok; stayLogin=1"; },
      extract: async () => { throw new Error("rendered path should not be used for dingtalk docs"); },
    },
  });
  const article = await clipper.extract("https://alidocs.dingtalk.com/i/nodes/gpG2NdyVX3mmZxQYHA1AGnXAWMwvDqPk?utm_scene=person_space");
  assert.equal(article.extractionMethod, "dingtalk-api");
  assert.equal(article.title, "新人百宝箱");
  assert.equal(article.byline, "张三");
  assert.equal(article.publishedAt, localIso(new Date(1700000000000)));
  // 代码块经 pre/code → 围栏 markdown,换行保留不拍平
  assert.ok(article.markdown.includes("```"));
  assert.ok(article.markdown.includes("DOC_ENGINE=elasticsearch\nSTACK_VERSION=8.11.3"));
  assert.equal(article.canonicalUrl, "https://alidocs.dingtalk.com/i/nodes/gpG2NdyVX3mmZxQYHA1AGnXAWMwvDqPk?utm_scene=person_space");
  assert.equal(cookieCalls[0], "dingtalk");
  assert.ok(JSON.stringify(article).includes("欢迎标题"));
  assert.ok(seen.every((call) => call.headers.cookie === "doc_atoken=tok; stayLogin=1"));
  assert.ok(seen.some((call) => call.headers["a-dentry-key"] === "nmbmj1wmconnN80l"));
  // 图片在 extract 层完成收集与绝对化(含 /core/api/resources/img 相对路径);
  // 下载 headers 由 saveArticle 阶段从 article.imageHeaders 透传给 this.download
  assert.equal(article.images.length, 2);
  assert.ok(article.images.some((url) => url.startsWith("https://alidocs.dingtalk.com/core/api/resources/img/")));
  assert.deepEqual(article.imageHeaders, { cookie: "doc_atoken=tok; stayLogin=1", "a-dentry-key": "nmbmj1wmconnN80l" });
});

test("DingTalk private docs surface the login guidance error without session cookies", async () => {
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async () => ({ response: { ok: true, status: 200, text: async () => "<html>redirect to login</html>" } }),
    sessionManager: { collectCookies: async () => "" },
  });
  await assert.rejects(
    clipper.extract("https://alidocs.dingtalk.com/i/nodes/gpG2NdyVX3mmZxQYHA1AGnXAWMwvDqPk"),
    (error) => error.code === "DINGTALK_DENTRY_KEY_NOT_FOUND" && /浏览器会话/.test(error.message),
  );
});

test("DingTalk attachment docs (uni-preview?previewAtta=1) download as binary file", async () => {
  const downloadCalls = [];
  const clipper = new WebClipper({}, dingtalkTestSettings(), {
    fetch: async (url) => {
      if (String(url).includes("/box/api/v2/file/download")) {
        return { response: { ok: true, status: 200, json: async () => ({
          status: 200, isSuccess: true,
          data: { downloadType: "URL_PRE_SIGNATURE", ossUrlPreSignatureInfo: { preSignUrls: ["https://cdn.dingtalk.com/file.docx"] } },
        }) } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    sessionManager: { collectCookies: async () => "session=abc" },
    download: async (url) => {
      downloadCalls.push(String(url));
      return { buffer: Buffer.from("fake-docx"), fileName: "test.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    },
  });
  const article = await clipper.extract("https://alidocs.dingtalk.com/uni-preview?extension=docx&bizType=document&cloudSpaceDentryId=234268596550&previewAtta=1&cloudSpaceSpaceId=29449443993&version=24&scene=universalSpace&dentryUuid=R4GpnMqJzZl2gee6iLPNOr5lJKe0xjE3&fileId=234268596550");
  assert.equal(article.extractionMethod, "dingtalk-file-attachment");
  assert.equal(article.extractionStatus, "complete");
  assert.ok(article.title.endsWith(".docx"));
  assert.ok(article.excerpt.includes("docx"));
  assert.equal(article.binaryFiles.length, 1);
  assert.ok(article.binaryFiles[0].fileName.endsWith(".docx"));
  assert.ok(article.markdown === "");
  assert.deepEqual(downloadCalls, ["https://cdn.dingtalk.com/file.docx"]);
});

test("DingTalk spreadsheet (spreadsheetv2) exports xlsx via headless buffer path", async () => {
  const dingtalkDocs = require("../src/clip/cloud-docs/dingtalk-docs");
  const fakeBuffer = Buffer.from("fake-xlsx-content");
  const origExport = dingtalkDocs.exportDingtalkSpreadsheet;
  dingtalkDocs.exportDingtalkSpreadsheet = async () => ({ buffer: fakeBuffer, fileName: "bQ0O0KO0c1XKJNVb.xlsx" });
  try {
    const clipper = new WebClipper({}, dingtalkTestSettings(), {
      fetch: async () => { throw new Error("fetch should not be called for spreadsheet export"); },
      sessionManager: { collectCookies: async () => "doc_atoken=tok; XSRF-TOKEN=abc" },
    });
    const article = await clipper.extract("https://alidocs.dingtalk.com/spreadsheetv2/bQ0O0KO0c1XKJNVb/edit?docId=1wvqre5dm5PGMnak&dentryKey=bQ0O0KO0c1XKJNVb");
    assert.equal(article.extractionMethod, "dingtalk-spreadsheet-export");
    assert.equal(article.extractionStatus, "complete");
    assert.equal(article.binaryFiles.length, 1);
    assert.equal(article.binaryFiles[0].buffer, fakeBuffer);
    assert.equal(article.binaryFiles[0].fileName, "bQ0O0KO0c1XKJNVb.xlsx");
    assert.ok(article.binaryFiles[0].mimeType.includes("spreadsheetml"));
  } finally {
    dingtalkDocs.exportDingtalkSpreadsheet = origExport;
  }
});

test("articleFromHtml falls back to og:video and video tags when no dedicated extraction", () => {
  const html = `<!doctype html><html><head><meta property="og:video:secure_url" content="https://cdn.example.com/og.mp4"></head><body><main><h1>Blog post</h1><p>${"Content. ".repeat(30)}</p><video src="/videos/local.mp4"></video><video><source src="https://cdn.example.com/source.mp4"></video></main></body></html>`;
  const article = articleFromHtml(html, "https://blog.example.com/post/1");
  assert.deepEqual(article.videoUrls, [
    "https://cdn.example.com/og.mp4",
    "https://blog.example.com/videos/local.mp4",
    "https://cdn.example.com/source.mp4",
  ]);
});

test("articleFromHtml video fallback caps at five entries", () => {
  const videos = Array.from({ length: 6 }, (_, i) => `<video src="https://cdn.example.com/v${i}.mp4"></video>`).join("");
  const html = `<!doctype html><html><body><main><h1>Gallery</h1><p>${"Content. ".repeat(30)}</p>${videos}</main></body></html>`;
  const article = articleFromHtml(html, "https://blog.example.com/gallery");
  assert.equal(article.videoUrls.length, 5);
  assert.equal(article.videoUrls[4], "https://cdn.example.com/v4.mp4");
});

test("articleFromHtml keeps override videoUrls over the fallback scan", () => {
  const html = `<!doctype html><html><head><meta property="og:video" content="https://cdn.example.com/og.mp4"></head><body><main><h1>Dedicated</h1><p>${"Content. ".repeat(30)}</p></main></body></html>`;
  const article = articleFromHtml(html, "https://blog.example.com/dedicated", { videoUrls: ["https://dedicated.example.com/final.mp4"] });
  assert.deepEqual(article.videoUrls, ["https://dedicated.example.com/final.mp4"]);
});

test("isWeixinSphUrl recognizes channels links only", () => {
  assert.equal(isWeixinSphUrl("https://weixin.qq.com/sph/A34MtNap4v"), true);
  assert.equal(isWeixinSphUrl("https://channels.weixin.qq.com/finder-preview/abc"), true);
  assert.equal(isWeixinSphUrl("https://mp.weixin.qq.com/s/abc"), false);
  assert.equal(isWeixinSphUrl("https://weixin.qq.com/sphX/abc"), false);
  assert.equal(isWeixinSphUrl("not a url"), false);
});

test("weixin sph links keep metadata via the generic render fallback", async () => {
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    fetch: async () => ({
      response: fakeHtmlResponse("<html><head><title>视频号</title></head><body>shell</body></html>"),
      finalUrl: "https://weixin.qq.com/sph/A34MtNap4v",
    }),
    sessionManager: {
      extract: async () => ({
        html: `<html><body><main><h1>真实标题</h1><p>${"作者与简介内容,点赞转发数据。".repeat(12)}</p></main></body></html>`,
        url: "https://weixin.qq.com/sph/A34MtNap4v",
        title: "真实标题",
        author: "作者",
        text: "作者与简介内容,点赞转发数据。".repeat(12),
      }),
    },
  });
  const article = await clipper.extract("https://weixin.qq.com/sph/A34MtNap4v");
  assert.equal(article.title, "真实标题");
  assert.equal(article.extractionStatus, "complete");
});

test("weixin sph render failures degrade to partial with a reason", async () => {
  const clipper = new WebClipper({}, zhihuTestSettings(), {
    fetch: async () => ({
      response: fakeHtmlResponse("<html><head><title>视频号</title></head><body>shell</body></html>"),
      finalUrl: "https://weixin.qq.com/sph/A34MtNap4v",
    }),
    sessionManager: { extract: async () => { throw new Error("browser session unavailable"); } },
  });
  const article = await clipper.extract("https://weixin.qq.com/sph/A34MtNap4v");
  assert.equal(article.extractionStatus, "partial");
  // warning 携带真实原因(渲染错误信息或 sph 降级说明),不再报「已提取正文」
  assert.match(article.renderWarning, /browser session unavailable|视频号渲染提取失败/);
});
