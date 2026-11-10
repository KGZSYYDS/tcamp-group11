/**
 * Set-Cookie 拆条回归用例。
 *
 * 用真实抓下来的响应头形状：办事大厅在票据校验那一步一次种 4 条 cookie，
 * 其中 MOD_AUTH_CAS 是「已登录」的唯一凭据。少解析一条就等于没登录。
 *
 * 用法：node scripts/test-set-cookie.mjs
 */
import { splitSetCookie } from "../lib/set-cookie.mjs";

const cases = [];
const check = (name, actual, expected) =>
  cases.push([name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`]);

/* ---- 多条被合并成一条（最常见的坏情况） ---- */
check(
  "ehall 票据校验：4 条一次拆开",
  splitSetCookie(
    "route=8fa759; Path=/, MOD_AUTH_CAS=MOD_AUTH_ST-123; Path=/; HttpOnly, asessionid=c12d7d; Path=/; HttpOnly, JSESSIONID=nk3Aem; Path=/; HttpOnly"
  ),
  [
    "route=8fa759; Path=/",
    "MOD_AUTH_CAS=MOD_AUTH_ST-123; Path=/; HttpOnly",
    "asessionid=c12d7d; Path=/; HttpOnly",
    "JSESSIONID=nk3Aem; Path=/; HttpOnly",
  ]
);

/* ---- 单条、且 Expires 里带逗号：不能被误切 ---- */
check(
  "Expires 的逗号不是分隔符（删除态）",
  splitSetCookie("CASTGC=; Path=/authserver/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly"),
  ["CASTGC=; Path=/authserver/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly"]
);
check(
  "带 Expires 的正常 cookie",
  splitSetCookie("a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/"),
  ["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/"]
);

/* ---- 混合：前一条带 Expires，后面还有 cookie ---- */
check(
  "Expires + 后续 cookie 同时出现",
  splitSetCookie("a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/, b=2; Path=/"),
  ["a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/", "b=2; Path=/"]
);

/* ---- 值里含 "=" 与 base64 里的 "/"、"+" ---- */
check(
  "value 里的 = 保留",
  splitSetCookie("happyVoyage=cT/vXy+ab==; Path=/; Secure"),
  ["happyVoyage=cT/vXy+ab==; Path=/; Secure"]
);

/* ---- 空值 ---- */
check("空字符串", splitSetCookie(""), []);
check("null", splitSetCookie(null), []);
check("undefined", splitSetCookie(undefined), []);

/* ---- 真实 dump：从本地会话文件里那份头的形状复刻 ---- */
check(
  "authserver 三条（含 route 在前）",
  splitSetCookie("route=7124f7; Path=/, JSESSIONID=A56F33; Path=/authserver; HttpOnly, insert_cookie=381895; Path=/"),
  ["route=7124f7; Path=/", "JSESSIONID=A56F33; Path=/authserver; HttpOnly", "insert_cookie=381895; Path=/"]
);

let pass = 0;
const fails = [];
for (const [name, ok, detail] of cases) {
  if (ok) pass += 1;
  else fails.push(`${name}（${detail}）`);
}

console.log(`Set-Cookie 拆条：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
