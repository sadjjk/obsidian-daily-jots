// 腾讯文档专用处理:收敛渲染提取后的页面 chrome 清洗。
// 腾讯文档渲染页会把工具栏/菜单按钮文字与只读横幅混进正文短行
// (菜单/插入/标题 1/默认字体/快捷工具…、View only / Log in now),
// 这里按完全锚定的短行黑名单剥离;长正文行不受影响。
const TENCENT_UI_LINE = new RegExp("^(?:" + [
  "菜单", "插入", "更多", "大纲", "打印", "保存", "撤销", "重做", "查找", "替换",
  "视图", "帮助", "反馈", "分享", "评论", "收藏", "导出", "下载", "关闭", "取消",
  "复制", "粘贴", "剪切", "加粗", "斜体", "下划线", "删除线", "字体", "字号", "默认字体",
  "小二", "小四", "四号", "五号", "正文", "引用", "高亮", "批注", "表格", "图片",
  "链接", "代码块", "分隔线", "页面", "缩放", "快捷工具", "PDF转换", "生成图片", "排版美化",
  "腾讯文档", "微信", "QQ", "登录", "注册", "扫码", "标题\\s?\\d?",
].join("|") + ")$", "i");

function stripTencentChrome(markdown) {
  return String(markdown || "").split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.length <= 14 && TENCENT_UI_LINE.test(trimmed)) return false;
    if (trimmed.length <= 60 && /^(view only|log in now|log in to|login\b)/i.test(trimmed)) return false;
    return true;
  }).join("\n");
}

module.exports = { stripTencentChrome };
