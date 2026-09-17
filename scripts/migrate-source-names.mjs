#!/usr/bin/env node
// 旧剪藏笔记归类迁移脚本:
//   1) Community(旧 community 家族遗留)整体搬迁到 Social,按来源表补来源段;
//   2) Articles 里映射命中的笔记搬到 Social(云文档/PDF 判定同步生效),未命中的留在 Articles 补「普通网页」段;
//   3) 所有搬迁/改名同步更新 Daily 日记里的双链(wikilink 与 md 链接两种形态)。
//   只改文件名与双链路径,不动正文;默认 dry-run,--apply 才真改。
// 用法:
//   node scripts/migrate-source-names.mjs [--vault <路径>] [--apply]

import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const { BUILTIN_SOURCE_NAMES, sourceNameForUrl } = requireLocal(
  fileURLToPath(new URL("../src/core/source-names.js", import.meta.url)),
);
const { classifyClipFamily, resolveClipFolder } = requireLocal(
  fileURLToPath(new URL("../src/core/clip-rules.js", import.meta.url)),
);

function parseArgs(argv) {
  const args = { apply: false, vault: "/Users/claw/Desktop/ObsidianProject" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--vault") args.vault = resolve(argv[++i] || "");
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function yamlSourcePath(content) {
  const match = content.match(/^source:\s*["']?(.+?)["']?\s*$/m);
  return match ? match[1].trim() : "";
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.*?)-([0-9a-f]{8,16})\.md$/;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法: node scripts/migrate-source-names.mjs [--vault <路径>] [--apply]");
    return;
  }
  const dataPath = join(args.vault, ".obsidian/plugins/omnichannel-diary/data.json");
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const clippingRoot = join(args.vault, data.storage?.clippingFolder || "Omnichannel Diary/Clippings");
  const diaryDir = join(args.vault, data.storage?.diaryFolder || "Omnichannel Diary/Daily");
  const settings = {
    capture: { sourceNameOverrides: data.capture?.sourceNameOverrides || {}, clipRules: data.capture?.clipRules },
  };
  const overrides = settings.capture.sourceNameOverrides || {};
  const knownNames = new Set([...Object.values(BUILTIN_SOURCE_NAMES), ...Object.values(overrides), "普通网页"]);
  const moves = [];
  const stats = { scanned: 0, moved: 0, renamed: 0, skipped: 0, unmapped: 0, links: 0 };
  // stem 是否已带来源段:整段命中、首段(`-` 前)命中、或恰好等于目标来源名。
  const hasLabel = (stem, label) => stem === label || knownNames.has(stem) || knownNames.has(stem.split("-")[0]);

  function planMove(dir, name, targetFolderName, nextName) {
    const from = `${dir}/${name}`;
    const to = `${clippingRoot}/${targetFolderName}/${nextName}`;
    if (from === to) {
      stats.skipped += 1;
      return;
    }
    moves.push({ from, to });
    if (name !== nextName) stats.renamed += 1;
    stats.moved += 1;
    if (args.apply) renameSync(from, to);
    console.log(`${args.apply ? "移动" : "[dry-run] 将移动"}: ${basename(dir)}/${name}${dir === to ? "" : ` -> ${targetFolderName}/${nextName}`}`);
  }

  function processFolder(dirName, familyOverride) {
    const dir = join(clippingRoot, dirName);
    let entries;
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (_) {
      console.log(`跳过(目录不存在): ${dir}`);
      return;
    }
    for (const name of entries) {
      stats.scanned += 1;
      const match = name.match(FILENAME_RE);
      if (!match) {
        stats.skipped += 1;
        continue;
      }
      const [, date, stem, hash] = match;
      const content = readFileSync(join(dir, name), "utf8");
      const sourceUrl = yamlSourcePath(content);
      const label = sourceNameForUrl(sourceUrl, settings)
        || (familyOverride === "Community" || dirName === "Articles" ? "普通网页" : null);
      if (!label) {
        stats.unmapped += 1;
        console.log(`未映射(跳过): ${dirName}/${name}`);
        continue;
      }
      if (familyOverride === "Community") {
        // Community -> Social:一律搬迁;已带来源段的保留原名。
        const targetFolder = data.capture?.clipRules?.social?.folder || "Social";
        planMove(dir, name, targetFolder, hasLabel(stem, label) ? name : `${date}-${label}-${stem}-${hash}.md`);
        continue;
      }
      if (dirName === "Articles") {
        // Articles 重分类:按当前规则决定归属;留 Articles 的补「普通网页」段。
        const family = classifyClipFamily(sourceUrl, null, settings);
        const targetFolder = basename(resolveClipFolder(settings, family));
        if (targetFolder === dirName && hasLabel(stem, label)) {
          stats.skipped += 1;
          continue;
        }
        const nextName = hasLabel(stem, label) ? name : `${date}-${label}-${stem}-${hash}.md`;
        planMove(dir, name, targetFolder, nextName);
        continue;
      }
      // Social:仅补来源段,不搬。
      if (hasLabel(stem, label)) {
        stats.skipped += 1;
        continue;
      }
      planMove(dir, name, dirName, `${date}-${label}-${stem}-${hash}.md`);
    }
  }

  processFolder("Community", "Community");
  processFolder("Articles", "Articles");
  processFolder(data.capture?.clipRules?.social?.folder || "Social", "Social");

  if (moves.length > 0) {
    let diaryEntries;
    try {
      diaryEntries = readdirSync(diaryDir).filter((name) => name.endsWith(".md"));
    } catch (_) {
      diaryEntries = [];
    }
    for (const name of diaryEntries) {
      const path = join(diaryDir, name);
      let content = readFileSync(path, "utf8");
      let changed = 0;
      for (const { from, to } of moves) {
        const relFrom = from.slice(args.vault.length + 1);
        const relTo = to.slice(args.vault.length + 1);
        for (const [needle, replace] of [
          [relFrom, relTo],
          [relFrom.replace(/\.md$/, ""), relTo.replace(/\.md$/, "")],
        ]) {
          if (content.includes(needle)) {
            changed += content.split(needle).length - 1;
            content = content.split(needle).join(replace);
          }
        }
      }
      if (changed > 0) {
        stats.links += changed;
        console.log(`${args.apply ? "更新双链" : "[dry-run] 将更新双链"}: Daily/${name}(${changed} 处)`);
        if (args.apply) writeFileSync(path, content);
      }
    }
  }

  console.log(`\n扫描 ${stats.scanned} | 移动 ${stats.moved}(含改名 ${stats.renamed})| 已标注/无法解析 ${stats.skipped} | 未映射跳过 ${stats.unmapped} | 双链更新 ${stats.links}`);
  if (!args.apply && stats.moved > 0) console.log("以上为 dry-run 预览;确认无误后追加 --apply 执行。");
}

main();
