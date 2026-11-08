/**
 * 命令行入口：node scripts/ingest.mjs <文件> [--collector 名字] [--json]
 *
 * 和 check.mjs 一样，先编译再执行，结束后清理。
 * 目的是让采集方不用装任何东西、也不用理解 TypeScript，就能验证自己给的数据。
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const outDir = join(root, ".tmp-check");

if (!existsSync(tscBin)) {
  console.error("找不到 typescript，请先执行 npm ci");
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

const compiled = run([tscBin, "-p", "tsconfig.check.json"]);
if (compiled !== 0) {
  console.error(`\n编译失败，产物保留在 ${outDir}`);
  process.exit(compiled);
}

const cli = join(outDir, "scripts", "cli.js");
if (!existsSync(cli)) {
  console.error(`编译产物缺失：${cli}`);
  process.exit(1);
}

const code = run([cli, ...process.argv.slice(2)]);
rmSync(outDir, { recursive: true, force: true });
process.exit(code);
