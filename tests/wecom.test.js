"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WeComChannel } = require("../src/channels/wecom");

// 企微消息帧:纯文本消息,from.userid 存在(避开 senderName 的 this.t fallback)
function frame(content, msgid = "m", fromUser = "u") {
  return { body: { msgtype: "text", text: { content }, msgid, create_time: 0, from: { userid: fromUser } } };
}

test("wecom normalize flags file-restriction notices as systemNotice", () => {
  const ch = new WeComChannel({}, {});
  const env = ch.normalize(frame(
    "这份文件是限制下载/导出的文件，智能机器人暂时无法获取。可联系企业管理员在企业微信管理后台「安全管理——文件防泄漏——文件下载/导出限制」中修改设置，允许企业创建的智能机器人获取。",
  ));
  assert.equal(env.systemNotice, true);
});

test("wecom normalize does not flag ordinary text or single-keyword messages", () => {
  const ch = new WeComChannel({}, {});
  assert.equal(ch.normalize(frame("今天天气不错")).systemNotice, false);
  // 单独命中「文件防泄漏」但无「智能机器人无法获取」→ 不判
  assert.equal(ch.normalize(frame("请帮我查一下文件防泄漏的设置")).systemNotice, false);
  // 单独命中「机器人无法获取」但无「智能机器人」前缀 → 不判
  assert.equal(ch.normalize(frame("机器人无法获取权限")).systemNotice, false);
});

test("formatCaptureReceipt reports wecom systemNotice as a failure, not 'saved'", () => {
  const { formatCaptureReceipt } = require("../src/core/router");
  const out = formatCaptureReceipt(
    { systemNotice: true, clips: [], clipFailures: ["企业微信文件防泄漏限制，机器人无法获取文件内容"], diaryFolder: "Daily", attachmentFailures: [] },
    "zh-CN",
  );
  assert.match(out, /未能保存：企业微信文件防泄漏限制/);
  assert.doesNotMatch(out, /已保存/);
});
