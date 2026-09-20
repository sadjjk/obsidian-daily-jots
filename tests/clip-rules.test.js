"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DiaryService } = require("../src/core/diary");
const { WebClipper } = require("../src/core/webclip");
const { localDateParts } = require("../src/core/util");

test("localDateParts.iso uses local timezone offset", () => {
  const iso = localDateParts(new Date("2026-09-17T08:44:38.910Z")).iso;
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(iso).getTime(), new Date("2026-09-17T08:44:38.910Z").getTime());
});
const {
  classifyClipFamily,
  defaultClipRules,
  isClipFamilyEnabled,
  normalizeClipRules,
  resolveClipFolder,
} = require("../src/core/clip-rules");
const { normalizeSettings } = require("../src/core/settings");

test("URLs are classified by source family before they are saved", () => {
  assert.equal(classifyClipFamily("https://example.com/blog/hello"), "articles");
  assert.equal(classifyClipFamily("https://x.com/openai/status/1234567890123456789"), "social");
  assert.equal(classifyClipFamily("https://mp.weixin.qq.com/s/abc"), "social");
  assert.equal(classifyClipFamily("https://www.xiaohongshu.com/explore/64f"), "social");
  assert.equal(classifyClipFamily("https://news.ycombinator.com/item?id=1"), "social");
  assert.equal(classifyClipFamily("https://view.inews.qq.com/a/20260915A07B1600"), "social");
  assert.equal(classifyClipFamily("https://www.zhihu.com/question/2082906405447779781"), "social");
  assert.equal(classifyClipFamily("https://weibo.com/1", { extractionMethod: "ttarticle" }), "social");
  assert.equal(classifyClipFamily("https://openai.com/index/fyxer"), "articles");
  assert.equal(classifyClipFamily("https://news.example.com/story", { commentCount: 5 }), "articles");
  assert.equal(
    classifyClipFamily("https://community.obsidian.md/t/topic/123", {}, { capture: { sourceNameOverrides: { "community.obsidian.md": "Obsidian 论坛" } } }),
    "social",
  );
  assert.equal(classifyClipFamily("https://docs.qq.com/doc/abc"), "documents");
  assert.equal(classifyClipFamily("https://files.example.com/report.pdf"), "articles");
  assert.equal(classifyClipFamily("attachment://wechat/1/report.pdf", { extractionMethod: "pdf-text" }), "articles");
  assert.equal(classifyClipFamily("https://alidocs.dingtalk.com/i/nodes/xxx?utm_scene=person_space"), "documents");
});

test("document service clip labels the platform in filename and YAML platform", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: false, clipRules: defaultClipRules() },
  };
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    upsertText: async (path, content) => { writes.push({ path, content }); },
    saveBinary: async (folder, name) => `${folder}/${name}`,
  };
  const clipper = new WebClipper(writer, settings, { download: async () => { throw new Error("no images"); } });
  const saved = await clipper.saveArticle({
    url: "https://feishu.cn/docx/abc123",
    identityUrl: "https://feishu.cn/docx/abc123",
    title: "AI 鹊桥",
    siteName: "飞书云文档",
    byline: "",
    markdown: "Body text that is long enough to keep.",
    images: [],
    extractionMethod: "rendered-document-browser",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-18T00:00:00Z") });
  assert.match(saved.notePath, /^Clippings\/Documents\/2026-09-18\/2026-09-18-飞书文档-AI 鹊桥-/);
  assert.doesNotMatch(saved.notePath, /普通网页/);
  assert.match(writes[0].content, /platform: "飞书文档"/);
});

test("disabled clipping types stay in the daily note and skip extraction", async () => {
  const value = normalizeSettings({
    schemaVersion: 1,
    storage: { diaryFolder: "日记", clippingFolder: "剪藏", attachmentFolder: "附件" },
    capture: { autoClipLinks: true, clipRules: { articles: { enabled: false } } },
  });
  const writes = [];
  const diary = new DiaryService({
    append: async (path, content) => { writes.push({ path, content }); return { path }; },
  }, () => value, async () => {}, {
    webClipperFactory: () => ({ save: async () => { throw new Error("must not clip"); } }),
  });
  const result = await diary.capture({
    channel: "wechat",
    id: "disabled-article",
    timestamp: new Date("2026-09-02T02:00:00Z"),
    text: "看这篇 https://example.com/blog/hello",
    attachments: [],
  });
  assert.equal(result.clips.length, 0);
  assert.equal(result.clipFailures.length, 1);
  assert.match(result.clipFailures[0], /该剪藏类型已关闭/);
  assert.match(writes[0].content, /https:\/\/example.com\/blog\/hello/);
});

test("enabled clipping types write into typed subfolders under the clipping root", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: false, clipRules: defaultClipRules() },
  };
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const clipper = new WebClipper(writer, settings, { download: async () => { throw new Error("no images"); } });
  const saved = await clipper.saveArticle({
    url: "https://example.com/post",
    identityUrl: "https://example.com/post",
    title: "Example",
    siteName: "Example",
    byline: "",
    markdown: "Body text that is long enough to keep.",
    images: [],
    extractionMethod: "readability",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-02T00:00:00Z") });
  assert.match(saved.notePath, /^Clippings\/Articles\/2026-09-02\/2026-09-02-普通网页-Example-/);
  assert.match(writes[0].content, /platform: "普通网页"/);
  assert.equal(isClipFamilyEnabled(settings, "articles"), true);
  assert.equal(resolveClipFolder(settings, "social"), "Clippings/Social");
  assert.equal(normalizeClipRules({ articles: { folder: " /News\\\\Blogs/ " } }).articles.folder, "News/Blogs");
});

test("mapped source lands in Social with source label in filename and platform", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: true, clipRules: defaultClipRules() },
  };
  const writes = [];
  const binaries = [];
  const writer = {
    findTextBySuffix: () => "",
    upsertText: async (path, content) => { writes.push({ path, content }); },
    saveBinary: async (folder, name) => { binaries.push({ folder, name }); return `${folder}/${name}.png`; },
  };
  const clipper = new WebClipper(writer, settings, {
    download: async (url, opts) => ({ buffer: Buffer.from("img"), mimeType: "image/png", fileName: opts.fileName, finalUrl: url }),
  });
  const saved = await clipper.saveArticle({
    url: "https://www.ithome.com/0/891/329.htm",
    identityUrl: "https://www.ithome.com/0/891/329.htm",
    title: "IT之家新闻",
    siteName: "IT之家",
    byline: "",
    markdown: "Body text that is long enough to keep.\n\n![](https://www.ithome.com/a.png)",
    images: ["https://www.ithome.com/a.png"],
    extractionMethod: "readability",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-02T00:00:00Z") });
  assert.match(saved.notePath, /^Clippings\/Social\/2026-09-02\/2026-09-02-IT之家-IT之家新闻-/);
  assert.match(writes[0].content, /platform: "IT之家"/);
  assert.equal(binaries.length, 1);
  assert.match(binaries[0].name, /^IT之家新闻-img-01$/);
  assert.match(binaries[0].folder, /^Attachments\/Web\/2026-09-02\/2026-09-02-IT之家-IT之家新闻-[0-9a-f]+$/);
  assert.ok(writes[0].content.includes(encodeURI(binaries[0].folder + "/" + binaries[0].name + ".png")));
});
