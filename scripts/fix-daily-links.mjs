#!/usr/bin/env node
// Daily 日记双链修复:
//   Daily 里指向 Clippings 的双链可能还是旧文件名(来源段迁移前的形态)。
//   每条剪藏文件名尾部的 identity hash 全库唯一且不变——按 hash 建立索引,
//   把 Daily 双链重写到当前实际文件路径(wikilink 不带 .md;|alias、#heading 保留)。
// 用法:
//   node scripts/fix-daily-links.mjs [--vault <路径>] [--apply]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const { normalizeSettings } = requireLocal(
  fileURLToPath(new URL("../src/core/settings.js", import.meta.url)),
);

function parseArgs(argv) {
  const args = { apply: false, vault: "/Users/claw/Desktop/ObsidianProject" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--vault") args.vault = resolve(argv[++i] || "");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(join(args.vault, ".obsidian/plugins/omnichannel-diary/data.json"), "utf8"));
  const settings = normalizeSettings(data);
  const clippingRoot = join(args.vault, settings.storage.clippingFolder);
  const diaryDir = join(args.vault, settings.storage.diaryFolder);

  const indexByHash = new Map();
  for (const family of readdirSync(clippingRoot)) {
    const dir = join(clippingRoot, family);
    let entries;
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (_) {
      continue;
    }
    for (const name of entries) {
      const hash = name.match(/-([0-9a-f]{8,16})\.md$/)?.[1];
      if (hash) indexByHash.set(hash, `Omnichannel Diary/Clippings/${family}/${name.replace(/\.md$/, "")}`);
    }
  }

  const LINK_RE = /\[\[(Omnichannel Diary\/Clippings\/[^\]|#]+?)-([0-9a-f]{8,16})([^\]]*)\]\]/g;
  let fixed = 0;
  let missing = 0;
  for (const name of readdirSync(diaryDir).filter((n) => n.endsWith(".md"))) {
    const path = join(diaryDir, name);
    const before = readFileSync(path, "utf8");
    let changed = 0;
    const after = before.replace(LINK_RE, (whole, dirPath, hash, tail) => {
      const current = indexByHash.get(hash);
      if (!current) {
        missing += 1;
        return whole;
      }
      const expected = `[[${current}${tail}]]`;
      if (expected === whole) return whole;
      changed += 1;
      return expected;
    });
    if (changed > 0) {
      fixed += changed;
      console.log(`${args.apply ? "修复" : "[dry-run] 将修复"}: Daily/${name}(${changed} 处)`);
      if (args.apply) writeFileSync(path, after);
    }
  }
  console.log(`\n修复 ${fixed} 处 | 无法定位 ${missing} 处(文件已不存在)`);
  if (!args.apply && fixed > 0) console.log("以上为 dry-run 预览;追加 --apply 执行。");
}

main();
