"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSourceOverrides, sourceNameForUrl } = require("../src/clip/lib/source-names");

test("builtin exact-host matching", () => {
  assert.equal(sourceNameForUrl("https://view.inews.qq.com/a/20260915A07B1600"), "腾讯新闻");
  assert.equal(sourceNameForUrl("https://www.ithome.com/1/002/329.htm"), "IT之家");
  assert.equal(sourceNameForUrl("https://mp.weixin.qq.com/s/abc"), "微信公众号");
  assert.equal(sourceNameForUrl("https://daily.zhihu.com/story/9792567"), "知乎日报");
  assert.equal(sourceNameForUrl("https://v.douyin.com/jq6JF3Vyxi8/"), "抖音");
});

test("exact match does not leak across sibling subdomains", () => {
  assert.equal(sourceNameForUrl("https://mail.qq.com/t"), null);
  assert.equal(sourceNameForUrl("https://www.zhihu.com/question/1"), "知乎");
  assert.equal(sourceNameForUrl("https://openai.com/index/fyxer"), null);
});

test("custom override wins over builtin; wildcard fills families", () => {
  const settings = { capture: { sourceNameOverrides: {
    "juejin.cn": "稀土掘金",
    "*.qq.com": "腾讯新闻",
  } } };
  assert.equal(sourceNameForUrl("https://juejin.cn/post/1", settings), "稀土掘金");
  assert.equal(sourceNameForUrl("https://mail.qq.com/t", settings), "腾讯新闻");
  assert.equal(sourceNameForUrl("https://view.inews.qq.com/a/1", settings), "腾讯新闻");
  const precise = { capture: { sourceNameOverrides: { "mail.qq.com": "QQ邮箱" } } };
  assert.equal(sourceNameForUrl("https://mail.qq.com/t", precise), "QQ邮箱");
});

test("unmatched and invalid inputs return null; values sanitized", () => {
  assert.equal(sourceNameForUrl("not a url"), null);
  assert.equal(sourceNameForUrl("https://openai.com/index/fyxer", {}), null);
  const cleaned = normalizeSourceOverrides({ " Example.COM ": "坏/名字:很长很长很长很长很长很长很长很长" });
  assert.deepEqual(cleaned, { "example.com": "坏名字很长很长很长很长很长很长很长很长" });
  const truncated = normalizeSourceOverrides({ "long.com": "长".repeat(25) });
  assert.deepEqual(truncated, { "long.com": "长".repeat(20) });
});
