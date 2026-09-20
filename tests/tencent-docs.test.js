"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stripTencentChrome } = require("../src/clip/cloud-docs/tencent-docs");

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
