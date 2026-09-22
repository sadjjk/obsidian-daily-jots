"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DiaryService, normalizeDiaryMessage } = require("../src/core/diary");
const { WeChatChannel } = require("../src/channels/wechat");

function settings() {
  return {
    storage: { diaryFolder: "日记", clippingFolder: "剪藏", attachmentFolder: "附件", addSourceMetadata: true },
    capture: { autoClipLinks: false, downloadWebImages: false, downloadChatAttachments: false, maxFileMb: 20 },
    runtime: { recentMessageIds: [], pendingReceipts: [] },
  };
}

test("daily message blocks normalize blank lines and protect structural prefixes", () => {
  assert.equal(normalizeDiaryMessage("# title\r\n\r\n\r\nbody"), "\\# title\nbody");
  assert.equal(normalizeDiaryMessage("---\nbody"), "\\---\nbody");
  assert.equal(normalizeDiaryMessage("_(marker)_\nbody"), "\\_(marker)_\nbody");
});

test("a message is remembered only after its diary entry is written", async () => {
  const value = settings();
  let shouldFail = true;
  const writer = {
    append: async () => {
      if (shouldFail) throw new Error("disk full");
      return { path: "日记/today.md" };
    },
  };
  const diary = new DiaryService(writer, () => value, async () => {});
  const envelope = { channel: "wechat", id: "message-1", timestamp: new Date("2026-08-30T02:00:00Z"), text: "hello", attachments: [] };
  await assert.rejects(() => diary.capture(envelope), /disk full/);
  assert.deepEqual(value.runtime.recentMessageIds, []);

  shouldFail = false;
  const saved = await diary.capture(envelope);
  assert.equal(saved.messageKey, "wechat:message-1");
  assert.deepEqual(value.runtime.recentMessageIds, ["wechat:message-1"]);
  const duplicate = await diary.capture(envelope);
  assert.equal(duplicate.ignored, "duplicate");
});


test("multiple web links share one bounded capture window and one daily-note block", async () => {
  const value = settings();
  value.capture.autoClipLinks = true;
  value.capture.webClipBudgetSeconds = 25;
  const writes = [];
  const deadlines = [];
  const writer = {
    append: async (path, content) => { writes.push({ path, content }); return { path }; },
  };
  const diary = new DiaryService(writer, () => value, async () => {}, {
    webClipperFactory: () => ({
      save: async (url, source) => {
        deadlines.push(source.deadline);
        return {
          notePath: `剪藏/${url.endsWith("one") ? "one" : "two"}.md`,
          sourceLabel: "普通网页",
          article: { url, title: url.endsWith("one") ? "One" : "Two", extractionStatus: "complete" },
          savedImages: 0,
          imageFailures: [],
          fileFailures: [],
        };
      },
    }),
  });
  const original = "一起看 https://example.com/one 和 https://example.com/two";
  const result = await diary.capture({
    channel: "wechat", id: "multi-link", timestamp: new Date("2026-08-31T03:00:00Z"), text: original, attachments: [],
  });
  assert.equal(result.clips.length, 2);
  assert.equal(new Set(deadlines).size, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(writes[0].content, /网页剪藏 · 普通网页：\[\[剪藏\/one\]\]/);
  assert.match(writes[0].content, /网页剪藏 · 普通网页：\[\[剪藏\/two\]\]/);
});

test("chat PDF attachments are saved once and linked from the daily note without generating a clipping", async () => {
  const value = settings();
  value.capture.downloadChatAttachments = true;
  const writes = [];
  let binaryWrites = 0;
  const writer = {
    saveBinary: async (folder, fileName) => {
      binaryWrites += 1;
      return `${folder}/${fileName}`;
    },
    upsertText: async (path, content) => { writes.push({ path, content }); return { path }; },
    append: async (path, content) => { writes.push({ path, content }); return { path }; },
  };
  const diary = new DiaryService(writer, () => value, async () => {}, {});
  const result = await diary.capture({
    channel: "feishu",
    channelName: "飞书 / Lark",
    id: "pdf-message-1",
    timestamp: new Date("2026-08-31T09:00:00Z"),
    text: "",
    attachments: [{ fileName: "report.pdf", mimeType: "application/pdf", load: async () => ({ fileName: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") }) }],
  });
  assert.equal(binaryWrites, 1);
  assert.equal(result.savedAttachments, 1);
  assert.equal(result.clips.length, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /\[\[附件\/Chat\/2026-08-31\/feishu\/report\.pdf\]\]/);
});

test("WeChat advances its sync cursor only after every message succeeds", async () => {
  let saves = 0;
  const config = { token: "token", syncBuf: "old" };
  const channel = new WeChatChannel(config, { setStatus() {}, saveSettings: async () => { saves += 1; } });
  const update = { get_updates_buf: "new", msgs: [{ message_type: 1, message_id: "one", from_user_id: "user", create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text: "hello" } }] }] };
  channel.deliver = async () => ({ ok: false, error: new Error("reply failed") });
  await assert.rejects(() => channel.processUpdate(update), /reply failed/);
  assert.equal(config.syncBuf, "old");
  assert.equal(saves, 0);

  channel.deliver = async () => ({ ok: true });
  await channel.processUpdate(update);
  assert.equal(config.syncBuf, "new");
  assert.equal(saves, 1);
});
