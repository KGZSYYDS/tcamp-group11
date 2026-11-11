/**
 * 构建「本机运行 + 隧道映射」用的生产包。
 *
 * 为什么单独一个脚本：npm scripts 里 `VAR=x cmd` 的写法在 Windows 的 cmd.exe
 * 下不生效，会把环境变量当成命令名，构建就静默走了默认模式。
 * 这里用 Node 显式设 env，两个平台都一样。
 *
 * 构建成 public 模式是有意的：公网能访问到这台机器，所以「读本机微信密钥」
 * 「无鉴权写通知表」这类接口必须关掉。登录接口不受影响 —— 它照样从本机出网。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const r = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DEPLOY_MODE: "public",
      NEXT_PUBLIC_DEPLOY_MODE: "public",
      NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=4096",
    },
    stdio: "inherit",
  }
);

r.on("exit", (code) => process.exit(code ?? 1));
