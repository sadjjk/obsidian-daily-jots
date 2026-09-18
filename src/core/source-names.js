"use strict";

// 来源名映射:精确 host → 中文名。不做泛后缀(避免 *.qq.com 误判
// mail.qq.com / weread.qq.com),清单外子域由设置里的自定义规则补。
// 匹配优先级:自定义精确 > 内置精确 > 自定义 "*.domain" 通配(更长后缀优先)。
const BUILTIN_SOURCE_NAMES = {
  // 专有适配(有独立提取器的平台)
  "mp.weixin.qq.com": "微信公众号",
  "x.com": "X", "twitter.com": "X",
  "weibo.com": "微博", "weibo.cn": "微博", "m.weibo.cn": "微博", "s.weibo.com": "微博",
  "xiaohongshu.com": "小红书", "xhslink.com": "小红书",
  "douyin.com": "抖音", "v.douyin.com": "抖音", "iesdouyin.com": "抖音",
  "bilibili.com": "哔哩哔哩", "b23.tv": "哔哩哔哩",
  "zhihu.com": "知乎", "daily.zhihu.com": "知乎日报",
  // 社区与博客平台(海外,COMMUNITY_SERVICES hosts)
  "reddit.com": "Reddit", "redd.it": "Reddit",
  "news.ycombinator.com": "Hacker News",
  "stackoverflow.com": "Stack Overflow", "stackexchange.com": "Stack Overflow",
  "serverfault.com": "Stack Overflow", "superuser.com": "Stack Overflow",
  "askubuntu.com": "Stack Overflow", "mathoverflow.net": "Stack Overflow",
  "producthunt.com": "Product Hunt",
  "medium.com": "Medium", "dev.to": "DEV",
  "hashnode.com": "Hashnode", "hashnode.dev": "Hashnode",
  "substack.com": "Substack", "lobste.rs": "Lobsters",
  "indiehackers.com": "Indie Hackers", "github.com": "GitHub",
  // 国内媒体与社区(热榜清单,精确 host)
  "view.inews.qq.com": "腾讯新闻", "new.qq.com": "腾讯新闻",
  "thepaper.cn": "澎湃新闻", "news.ifeng.com": "凤凰新闻",
  "c.m.163.com": "网易新闻", "music.163.com": "网易云音乐",
  "ithome.com": "IT之家", "sspai.com": "少数派", "ifanr.com": "爱范儿",
  "huxiu.com": "虎嗅", "36kr.com": "36氪", "52pojie.cn": "吾爱破解",
  "appinn.com": "小众软件", "bbs.hupu.com": "虎扑", "douban.com": "豆瓣",
  "gamersky.com": "游民星空", "dapenti.com": "喷嚏网", "news.zhibo8.cc": "直播吧",
  "user.guancha.cn": "观风闻", "news.10jqka.com": "同花顺", "oschina.net": "开源中国",
  "post.smzdm.com": "什么值得买", "m.xiaomiyoupin.com": "小米有品",
  "toutiao.com": "今日头条", "xueqiu.com": "雪球", "tieba.baidu.com": "百度贴吧",
  "baidu.com": "百度", "iqiyi.com": "爱奇艺", "kuaishou.com": "快手",
  "acfun.cn": "AcFun", "pearvideo.com": "梨视频", "xiaoyuzhoufm.com": "小宇宙",
  "ximalaya.com": "喜马拉雅", "kugou.com": "酷狗音乐", "weread.qq.com": "微信读书",
  "jiqizhixin.com": "机器之心", "qbitai.com": "量子位", "news.aibase.com": "AIBase",
  "geekpark.net": "极客公园", "feng.com": "威锋", "aiera.com.cn": "新智元",
  "news.mydrivers.com": "快科技", "myzaker.com": "ZAKER", "iplaysoft.com": "异次元软件",
  "latepost.com": "晚点", "mittrchina.com": "MIT科技评论", "dgtle.com": "数字尾巴",
  "guokr.com": "果壳", "solidot.org": "Solidot", "agirls.aotter.net": "電獺少女",
  "pingwest.com": "品玩", "cyzone.cn": "创业邦", "donews.com": "DoNews",
  "autohome.com.cn": "汽车之家", "club.autohome.com.cn": "汽车之家",
  "xchuxing.com": "新出行", "toodaylab.com": "理想生活实验室",
  "m.coolapk.com": "酷安", "landian.news": "蓝点网", "api.xiaoheihe.cn": "小黑盒",
  "ngabbs.com": "NGA", "dongqiudi.com": "懂球帝", "news.17173.com": "17173",
  "3dmgame.com": "3DM", "gcores.com": "机核", "qidian.com": "起点中文网",
  "taptap.cn": "TapTap", "newsmth.net": "水木社区", "club.kdslife.com": "宽带山",
  "finance.eastmoney.com": "东方财富", "wallstreetcn.com": "华尔街见闻",
  "xnews.jin10.com": "金十数据", "caixin.com": "财新", "finance.sina.cn": "新浪财经",
  "m.jiemian.com": "界面新闻", "gelonghui.com": "格隆汇",
  "juejin.cn": "掘金", "infoq.cn": "InfoQ", "segmentfault.com": "SegmentFault",
  "bbs.kanxue.com": "看雪", "blog.csdn.net": "CSDN",
  "woshipm.com": "人人都是产品经理", "cnblogs.com": "博客园",
  "hellogithub.com": "HelloGitHub", "huggingface.co": "Hugging Face", "daily.dev": "daily.dev",
};

function normalizeHost(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

// 自定义规则清洗:key 去 www、小写;value 去文件名/YAML 不安全字符,≤20 字。
function normalizeSourceOverrides(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  const output = {};
  for (const [rawHost, rawName] of Object.entries(source)) {
    const host = String(rawHost || "").trim().toLowerCase().replace(/^www\./, "");
    const name = String(rawName || "").trim().replace(/[\\/: \n\r\t]/g, "").slice(0, 20);
    if (!host || !name) continue;
    output[host] = name;
  }
  return output;
}

function sourceNameForUrl(url, settings) {
  const host = normalizeHost(url);
  if (!host) return null;
  const overrides = normalizeSourceOverrides(settings?.capture?.sourceNameOverrides);
  if (overrides[host]) return overrides[host];
  if (BUILTIN_SOURCE_NAMES[host]) return BUILTIN_SOURCE_NAMES[host];
  // 自定义 "*.domain" 通配:最长 domain 优先;内置表无通配。
  let best = null;
  let bestLength = -1;
  for (const [pattern, name] of Object.entries(overrides)) {
    if (!pattern.startsWith("*.")) continue;
    const domain = pattern.slice(2);
    if (domain && host.endsWith(`.${domain}`) && domain.length > bestLength) {
      best = name;
      bestLength = domain.length;
    }
  }
  return best;
}

// 名称不含中文但实际属于国内站点的来源,用于设置面板「国内/国外」分组展示。
const BUILTIN_CHINA_SOURCE_NAMES = new Set([
  "AcFun",
  "NGA",
  "CSDN",
  "3DM",
  "17173",
  "InfoQ",
  "Solidot",
  "ZAKER",
  "DoNews",
  "AIBase",
  "TapTap",
]);

module.exports = { BUILTIN_CHINA_SOURCE_NAMES, BUILTIN_SOURCE_NAMES, normalizeSourceOverrides, sourceNameForUrl };
