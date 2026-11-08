/**
 * 保存统一认证凭据到本地（data/.credentials.json，已被 gitignore）
 *
 * 用法：
 *   node scripts/save-credentials.mjs --user 482848 --pass ******
 *   或先设置环境变量 SZU_USER / SZU_PASS 再直接运行
 *
 * 只写本地文件，不打印密码。
 */
import { saveCredentials, loadCredentials, CRED_FILE } from "./lib/session.mjs";

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}

const user = opt("user") || process.env.SZU_USER;
const pass = opt("pass") || process.env.SZU_PASS;

if (user && pass) {
  saveCredentials(user, pass);
  console.log(`已保存：${CRED_FILE}`);
  console.log(`账号：${user}  密码：已写入（${pass.length} 位）`);
} else {
  const existing = loadCredentials();
  if (existing) {
    console.log(`已有凭据：${CRED_FILE}`);
    console.log(`账号：${existing.username}  密码：已保存（${existing.password.length} 位）`);
  } else {
    console.error("没有可用凭据。用法：node scripts/save-credentials.mjs --user <学号> --pass <密码>");
    process.exit(1);
  }
}
