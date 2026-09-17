#!/usr/bin/env node
// 旧剪藏笔记来源段改名脚本:
//   扫描 <vault>/<clippingFolder>/{Social,Articles} 下的 .md,
//   读 YAML source 域名 → sourceNameForUrl(内置表 + vault 设置里的自定义规则),
//   在文件名日期段后插入来源段(未收录 → Articles 插「普通网页」)。
//   只改文件名,不动正文;默认 dry-run,--apply 才真改。
//   已含来源段(第二段 == 目标来源名,或属于已知来源名集合)的文件跳过。
// 用法:
//   node scripts/migrate-source-names.mjs [--vault <路径>] [--apply]

import { readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const { BUILTIN_SOURCE_NAMES, sourceNameForUrl } = requireLocal(
  fileURLToPath(new URL("../src/core/source-names.js", import.meta.url)),
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
  const settings = {
    capture: { sourceNameOverrides: data.capture?.sourceNameOverrides || {} },
  };
  const knownNames = new Set([...Object.values(BUILTIN_SOURCE_NAMES), "普通网页"]);
  const folders = {
    Social: data.capture?.clipRules?.social?.folder || "Social",
    Articles: data.capture?.clipRules?.articles?.folder || "Articles",
  };
  const stats = { scanned: 0, renamed: 0, skipped: 0, unmapped: 0 };
  for (const [family, folder] of Object.entries(folders)) {
    const dir = join(clippingRoot, folder);
    let entries;
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (_) {
      console.log(`跳过(目录不存在): ${dir}`);
      continue;
    }
    for (const name of entries) {
      stats.skipped += 0;
      stats.scanned += 1;
      const match = name.match(FILENAME_RE);
      if (!match) {
        stats.skipped += 1;
        continue;
      }
      const [, date, stem, hash] = match;
      if (knownNames.has(stem)) {
        stats.skipped += 1;
        continue;
      }
      const content = readFileSync(join(dir, name), "utf8");
      const label = sourceNameForUrl(yamlSourcePath(content), settings) || (family === "Articles" ? "普通网页" : null);
      if (!label) {
        stats.unmapped += 1;
        console.log(`未映射(跳过): ${folder}/${name}`);
        continue;
      }
      if (stem === label) {
        stats.skipped += 1;
        continue;
      }
      const next = `${date}-${label}-${stem}-${hash}.md`;
      console.log(`${args.apply ? "改名" : "[dry-run] 将改名"}: ${folder}/${name} -> ${next}`);
      if (args.apply) renameSync(join(dir, name), join(dir, next));
      stats.renamed += 1;
    }
  }
  console.log(`\n扫描 ${stats.scanned} | 改名 ${stats.renamed} | 已标注/无法解析 ${stats.skipped} | 未映射跳过 ${stats.unmapped}`);
  if (!args.apply && stats.renamed > 0) console.log("以上为 dry-run 预览;确认无误后追加 --apply 执行改名。");
}

main();
