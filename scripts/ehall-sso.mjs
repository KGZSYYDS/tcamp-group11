/**
 * 用已有的 CAS TGT（CASTGC cookie）换新票据，避免反复提交密码触发风控。
 * 成功则把新的 ehall 会话写入 data/.ehall-session.json。
 */
import fs from "fs";
import { CookieJar } from "./lib/cas.mjs";
import { saveEhallSession } from "./lib/session.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0";
const raw = fs.readFileSync("data/.cookie-ehall.txt", "utf-8");
const tgt = /CASTGC=([^;]+)/.exec(raw)?.[1];
if (!tgt) throw new Error("缓存里没有 CASTGC");

const CAS = "https://authserver.szu.edu.cn";
const SERVICE = "https://ehall.szu.edu.cn:443/amp/login";
const loginUrl = `${CAS}/authserver/login?service=${encodeURIComponent(SERVICE)}`;

const res = await fetch(loginUrl, {
  headers: { Cookie: `CASTGC=${tgt}`, "User-Agent": UA },
  redirect: "manual",
});
console.log("CAS 响应:", res.status, res.headers.get("location") || "(无跳转)");
if (res.status !== 302) {
  console.log("TGT 已失效，需要重新登录");
  process.exit(2);
}

const jar = new CookieJar();
jar.store.set("authserver.szu.edu.cn", new Map([["CASTGC", tgt]]));

let cur = new URL(res.headers.get("location"), CAS).toString();
for (let i = 0; i < 8; i++) {
  const r = await fetch(cur, {
    headers: { Cookie: jar.headerFor(cur), "User-Agent": UA },
    redirect: "manual",
  });
  jar.addFromResponse(r, new URL(cur).hostname.toLowerCase());
  const loc = r.headers.get("location");
  console.log(`  [${i}] ${r.status} ${cur.slice(0, 85)}`);
  if (r.status >= 300 && r.status < 400 && loc) {
    cur = new URL(loc, cur).toString();
    continue;
  }
  break;
}

const check = await fetch("https://ehall.szu.edu.cn/jsonp/userInfo.json", {
  headers: { Cookie: jar.headerFor("https://ehall.szu.edu.cn/"), "User-Agent": UA },
});
const txt = await check.text();
jar.addFromResponse(check, "ehall.szu.edu.cn");
const ok = /"hasLogin"\s*:\s*true/.test(txt);
console.log("ehall 会话:", ok ? "有效" : "无效");
if (ok) {
  saveEhallSession(jar);
  console.log("已保存 data/.ehall-session.json");
} else process.exit(1);
