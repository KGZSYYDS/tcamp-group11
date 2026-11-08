/**
 * 离线自检入口：node scripts/check.mjs
 *
 * 之所以不写成 npm script，是为了不改 package.json —— 那是多人共用的文件，
 * 每加一行都是一次潜在冲突。
 *
 * 做的事：编译 scripts/ 及其依赖 → 跑 smoke.js → 清理临时目录 → 透传退出码。
 * 零额外依赖，Windows / macOS / Linux 通用。
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

rmSync(outDir, { recursive: true, force: true });

console.log("· 编译自检脚本…");
const compiled = run([tscBin, "-p", "tsconfig.check.json"]);
if (compiled !== 0) {
  console.error(`\n编译失败，产物保留在 ${outDir} 便于排查`);
  process.exit(compiled);
}

const smoke = join(outDir, "scripts", "smoke.js");
if (!existsSync(smoke)) {
  console.error(`编译产物缺失：${smoke}`);
  process.exit(1);
}

console.log("· 运行断言…\n");
const code = run([smoke]);

rmSync(outDir, { recursive: true, force: true });
process.exit(code);
