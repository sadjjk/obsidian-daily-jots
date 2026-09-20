"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureRouter, HELP_TEXT, formatCaptureReceipt, formatHelpText } = require("../src/core/router");
const { CHANNEL_IDS } = require("../src/core/settings");

test("help and status are deterministic and never invoke capture", async () => {
  let captures = 0;
  const replies = [];
  const router = new CaptureRouter({ capture: async () => { captures += 1; } }, () => ({ telegram: { state: "connected" } }));
  await router.handle({ text: "/help", reply: async (text) => replies.push(text) });
  await router.handle({ text: "/status", reply: async (text) => replies.push(text) });
  assert.equal(captures, 0);
  assert.equal(replies[0], HELP_TEXT);
  assert.match(replies[1], /1 个渠道在线/);
});

test("help and status follow the user's English language choice", async () => {
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("help must not capture") }, () => ({ telegram: { state: "connected" } }), {
    getLocale: () => "en",
    getStorage: () => ({ diaryFolder: "Notes/Daily" }),
    replyRetryDelays: [0],
  });
  await router.handle({ text: "help", reply: async (text) => replies.push(text) });
  await router.handle({ text: "/status", reply: async (text) => replies.push(text) });
  assert.equal(replies[0], formatHelpText("en", { diaryFolder: "Notes/Daily" }));
  assert.match(replies[0], /quick-capture ✍️/);
  assert.match(replies[0], /syncs straight into Obsidian/);
  assert.match(replies[1], /1 channel online/);
  assert.doesNotMatch(replies.join("\n"), /[\u4e00-\u9fff]/);
});

test("clip command passes only the URL to diary capture", async () => {
  let captured;
  const router = new CaptureRouter({ capture: async (envelope) => { captured = envelope; return { diaryPath: "Daily/today.md" }; } }, () => ({}));
  await router.handle({ text: "/clip https://example.com/post", attachments: [] });
  assert.equal(captured.text, "https://example.com/post");
});

test("capture receipts use the same friendly format across all nine channels", async () => {
  const replies = [];
  const diary = {
    capture: async (envelope) => ({
      diaryPath: "日记/2026-08-30.md",
      diaryFolder: "日记",
      clippingFolder: "全渠道剪藏",
      messageKey: `${envelope.channel}:1`,
      clips: [{
        notePath: "全渠道剪藏/article.md",
        article: { title: "月入30万美元，这位英国老兵把最“土”的网站做到了月访问791万", extractionStatus: "complete" },
        savedImages: 7,
        imageFailures: [],
      }],
      clipFailures: [],
      attachmentFailures: [],
    }),
    queueReceipt: async () => {},
    completeReceipt: async () => {},
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0] });
  for (const channel of CHANNEL_IDS) {
    await router.handle({ channel, text: "https://example.com", reply: async (text) => replies.push(text) });
  }
  assert.equal(new Set(replies).size, 1);
  assert.equal(replies.length, 9);
  assert.equal(replies[0], [
    "🔖 《月入30万美元，这位英国老兵把最“土”的网站做到了月访问791万》已提取正文和 7 张图片并保存到「全渠道剪藏」",
  ].join("\n"));
});

test("English capture receipts are friendly and identical across all nine channels", async () => {
  const replies = [];
  const diary = {
    capture: async (envelope) => ({
      diaryPath: "Daily/2026-08-30.md",
      diaryFolder: "Daily",
      clippingFolder: "Clippings",
      messageKey: `${envelope.channel}:english`,
      clips: [{
        notePath: "Clippings/article.md",
        article: { title: "A practical guide to local-first capture", extractionStatus: "complete" },
        savedImages: 1,
        imageFailures: [],
      }],
      clipFailures: [],
      attachmentFailures: [],
    }),
    queueReceipt: async () => {},
    completeReceipt: async () => {},
  };
  const router = new CaptureRouter(diary, () => ({}), { getLocale: () => "en", replyRetryDelays: [0] });
  for (const channel of CHANNEL_IDS) {
    await router.handle({ channel, text: "https://example.com", reply: async (text) => replies.push(text) });
  }
  assert.equal(new Set(replies).size, 1);
  assert.equal(replies.length, 9);
  assert.match(replies[0], /^🔖 “A practical guide to local-first capture” was saved to “Clippings” with the full text and 1 image\.$/);
  assert.doesNotMatch(replies[0], /quick-capture/);
  assert.doesNotMatch(replies[0], /[\u4e00-\u9fff]/);
});

test("reply retries and clears the durable receipt only after delivery", async () => {
  let attempts = 0;
  const events = [];
  const diary = {
    capture: async () => ({ diaryPath: "日记/today.md", messageKey: "wechat:retry", clips: [], clipFailures: [], attachmentFailures: [] }),
    queueReceipt: async (id, text) => events.push(["queued", id, text]),
    completeReceipt: async (id) => events.push(["completed", id]),
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0, 0, 0] });
  await router.handle({ text: "hello", reply: async () => { attempts += 1; if (attempts < 3) throw new Error("temporary"); } });
  assert.equal(attempts, 3);
  assert.equal(events[0][0], "queued");
  assert.deepEqual(events.at(-1), ["completed", "wechat:retry"]);
});

test("a replayed duplicate sends its pending receipt without saving twice", async () => {
  const replies = [];
  const completed = [];
  const diary = {
    capture: async () => ({ ignored: "duplicate", messageKey: "wechat:pending", pendingReceipt: "✅ 已保存\n日记：日记/today.md" }),
    completeReceipt: async (id) => completed.push(id),
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0] });
  await router.handle({ text: "hello", reply: async (text) => replies.push(text) });
  assert.deepEqual(replies, ["✅ 已保存\n日记：日记/today.md"]);
  assert.deepEqual(completed, ["wechat:pending"]);
});

test("partial extraction produces a warning instead of a false success", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ article: { title: "测试网页", extractionStatus: "partial" }, savedImages: 2, imageFailures: ["image"] }],
    clipFailures: [],
    attachmentFailures: [],
  });
  assert.match(text, /^⚠️ 《测试网页》正文提取不完整/);
  assert.match(text, /2 张图片/);
  assert.match(text, /另有 1 张图片保存失败/);
  assert.doesNotMatch(text, /随手记/);
});

test("failure receipts append per-link reasons after the summary line", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [],
    clipFailures: [
      "https://alidocs.dingtalk.com/note/preview?docId=abc&dentryKey=j7jrNLO1sQ0yKa0o: 钉钉文档 package 中未找到正文 body 节点(parts 中无 data.body)",
    ],
    attachmentFailures: [],
  });
  assert.match(text, /⚠️ 1 个网页未能提取正文，原始链接已保存在今天的「日记」/);
  assert.match(text, /原因：钉钉文档 package 中未找到正文 body 节点\(parts 中无 data\.body\)/);
  assert.doesNotMatch(text, /dentryKey=j7jrNLO1sQ0yKa0o:/); // URL 前缀不进回复
});

test("images skipped by the per-clipping limit are reported as kept remote URLs, not failures", () => {
  const skipped = Array.from({ length: 43 }, (_, i) => `https://alidocs.dingtalk.com/core/api/resources/img/${i}`);
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ article: { title: "操作手册", extractionStatus: "complete" }, savedImages: 30, imageFailures: [], imageSkipped: skipped }],
    clipFailures: [],
    attachmentFailures: [],
  });
  assert.match(text, /^🔖 《操作手册》已提取正文和 30 张图片并保存到「全渠道剪藏」，另有 43 张图片超出单篇上限已在正文保留原链$/);
  assert.doesNotMatch(text, /保存失败/);
  assert.doesNotMatch(text, /⚠️/);
  // 真失败仍按失败话术
  const mixed = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ article: { title: "操作手册", extractionStatus: "complete" }, savedImages: 30, imageFailures: ["img-31"], fileFailures: [] }],
    clipFailures: [],
    attachmentFailures: [],
  });
  assert.match(mixed, /⚠️ 《操作手册》已提取正文和 30 张图片并保存到「全渠道剪藏」，另有 1 张图片保存失败/);
});

test("diary-only receipts lead with the agent guide", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [], clipFailures: [], attachmentFailures: [],
  });
  assert.match(text, /^嗨~ 我是你的随手记✍️ /);
  assert.match(text, /已保存到今天的「日记」/);
});

test("clipping receipts embed a configurable markdown preview line", () => {
  const clip = { article: { title: "预览页", extractionStatus: "complete", markdown: "A".repeat(300) }, savedImages: 1, imageFailures: [] };
  const result = { diaryPath: "日记/today.md", clips: [clip], clipFailures: [], attachmentFailures: [] };
  const on = formatCaptureReceipt(result, "zh-CN", { enabled: true, chars: 200 });
  assert.match(on, /预览如下，仅展示前 200 字：\nA{200}…/);
  assert.doesNotMatch(on, /随手记/);
  const off = formatCaptureReceipt(result, "zh-CN", { enabled: false, chars: 200 });
  assert.doesNotMatch(off, /A{200}/);
  const reused = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ reused: true, notePath: "全渠道剪藏/x.md", savedImages: 0, imageFailures: [], fileFailures: [], article: { title: "x", extractionStatus: "complete", markdown: "B".repeat(300) } }],
  }, "zh-CN", { enabled: true, chars: 200 });
  assert.doesNotMatch(reused, /B{200}/);
});

test("receipt previews keep markdown line breaks after a blank line", () => {
  const clip = { article: { title: "多行页", extractionStatus: "complete", markdown: "第一段开头。\n\n第二段另起。第三段同段。" }, savedImages: 0, imageFailures: [] };
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [clip], clipFailures: [], attachmentFailures: [],
  }, "zh-CN", { enabled: true, chars: 200 });
  assert.match(text, /已提取正文和 0 张图片并保存到「全渠道剪藏」\n\n预览如下，仅展示前 200 字：\n第一段开头。\n\n第二段另起。第三段同段。/);
  assert.doesNotMatch(text, /› /);
});

test("receipt previews drop video links from the meta line", () => {
  const clip = {
    article: { title: "视频页", extractionStatus: "complete", markdown: "2024-06-04 17:00 · 转发 75 · [原文](https://m.weibo.cn/status/5041) · [视频](https://video.weibo.com/show?fid=1034:504151)\n\n正文第一行。" },
    savedImages: 0, imageFailures: [],
  };
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [clip], clipFailures: [], attachmentFailures: [],
  }, "zh-CN", { enabled: true, chars: 200 });
  assert.doesNotMatch(text, /video\.weibo\.com/);
  assert.doesNotMatch(text, /\[视频\]/);
  assert.match(text, /\[原文\]\(https:\/\/m\.weibo\.cn\/status\/5041\)\n\n正文第一行。/);
  assert.match(text, /预览如下，仅展示前 200 字：/);
});

test("receipt previews filter out images and count text only", () => {
  const clip = {
    article: { title: "头图页", extractionStatus: "complete", markdown: "![封面](https://img.example/cover.jpg)\n\n![配图](https://img.example/2.jpg)\n\n正文第一句在这。\n\n第二段。" },
    savedImages: 2, imageFailures: [],
  };
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [clip], clipFailures: [], attachmentFailures: [],
  }, "zh-CN", { enabled: true, chars: 200 });
  assert.doesNotMatch(text, /!\[/);
  assert.match(text, /保存到「全渠道剪藏」\n\n预览如下，仅展示前 200 字：\n正文第一句在这。\n\n第二段。/);
  assert.doesNotMatch(text, /\n\n\n/);
});

test("community receipts report captured comment threads in both languages", () => {
  const clip = { article: { title: "技术讨论", extractionStatus: "complete", commentCount: 26 }, savedImages: 3, imageFailures: [] };
  assert.match(formatCaptureReceipt({ diaryPath: "日记/today.md", clips: [clip] }), /正文、26 条评论和 3 张图片/);
  assert.match(formatCaptureReceipt({ diaryPath: "Daily/today.md", clips: [clip] }, "en"), /full text, 26 comments, and 3 images/);
});

test("reused clippings are reported consistently in Chinese and English", () => {
  const result = {
    diaryPath: "日记/2026-08-31.md",
    clippingFolder: "全渠道剪藏",
    clips: [{
      reused: true,
      notePath: "全渠道剪藏/reused.md",
      savedImages: 0,
      imageFailures: [],
      fileFailures: [],
      article: { title: "Existing page", extractionStatus: "complete" },
    }],
  };
  assert.match(formatCaptureReceipt(result, "zh-CN"), /之前已经保存，已复用/);
  assert.match(formatCaptureReceipt(result, "en"), /was already saved\. Reused/);
});

test("PDF receipts distinguish a saved original from an original-file failure", () => {
  const saved = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [{ article: { title: "在线报告", extractionStatus: "complete" }, savedImages: 0, savedFiles: 1, imageFailures: [], fileFailures: [] }],
  });
  assert.match(saved, /并保留 1 个原文件/);
  const failed = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [{ article: { title: "在线报告", extractionStatus: "complete" }, savedImages: 0, savedFiles: 0, imageFailures: [], fileFailures: ["pdf"] }],
  });
  assert.match(failed, /^⚠️/);
  assert.match(failed, /1 个原文件保存失败/);
});

test("chat PDF receipts report extracted pages and preserved attachments", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    diaryFolder: "日记",
    clippingFolder: "全渠道剪藏",
    clips: [{ article: { title: "季度报告", extractionStatus: "complete", extractionMethod: "pdf-text", pageCount: 12 }, savedImages: 0, savedFiles: 0, imageFailures: [], fileFailures: [] }],
    savedAttachments: 1,
    attachmentFailures: [],
    attachmentExtractionFailures: [],
    attachmentChatFolder: "Omnichannel Diary/Attachments/Chat",
  });
  assert.match(text, /^🔖 《季度报告》已提取 12 页 PDF 正文并保存到「全渠道剪藏」/);
  assert.match(text, /📎 已保存 1 个附件到「Omnichannel Diary\/Attachments\/Chat」/);
});

test("clipping receipts show the family subfolder path and source channel", () => {
  const text = formatCaptureReceipt({
    diaryPath: "Omnichannel Diary/Daily/2026-09-18.md",
    diaryFolder: "Omnichannel Diary/Daily",
    clips: [{
      notePath: "Omnichannel Diary/Clippings/Documents/2026-09-18/2026-09-18-钉钉文档-操作手册-abc123.md",
      sourceLabel: "钉钉文档",
      article: { title: "操作手册", extractionStatus: "complete" },
      savedImages: 30, imageFailures: [], imageSkipped: [], fileFailures: [],
    }],
    clipFailures: [], attachmentFailures: [],
  });
  assert.match(text, /已提取正文和 30 张图片并保存到「Omnichannel Diary\/Clippings\/Documents」，来自钉钉文档/);
  // 普通网页不加来源标注
  const plain = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ notePath: "全渠道剪藏/Articles/2026-09-18/x-abc.md", sourceLabel: "普通网页", article: { title: "x", extractionStatus: "complete" }, savedImages: 0, imageFailures: [], imageSkipped: [], fileFailures: [] }],
    clipFailures: [], attachmentFailures: [],
  });
  assert.match(plain, /保存到「全渠道剪藏\/Articles」/);
  assert.doesNotMatch(plain, /来自/);
});

test("textless photo-only articles omit body wording from receipts", () => {
  const clip = { article: { title: "潘卓 的图片笔记", extractionStatus: "complete", textless: true }, savedImages: 8, imageFailures: [] };
  const zh = formatCaptureReceipt({ diaryPath: "日记/today.md", clips: [clip] });
  assert.match(zh, /^🔖 《潘卓 的图片笔记》已提取 8 张图片并保存到「全渠道剪藏」/);
  assert.doesNotMatch(zh, /正文/);
  const en = formatCaptureReceipt({ diaryPath: "Daily/today.md", clippingFolder: "Clippings", clips: [clip] }, "en");
  assert.match(en, /was saved to “Clippings” with 8 images\./);
  assert.doesNotMatch(en, /full text|available text/);
});

