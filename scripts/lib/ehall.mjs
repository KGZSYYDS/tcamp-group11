/**
 * 办事大厅（ehall）会话：优先复用磁盘缓存，失效才走统一认证重新登录。
 * 统一认证对短时间内的重复登录会返回 401，所以务必复用一个 jar。
 */
import { casLogin, CookieJar } from "./cas.mjs";
import { loadCredentials, loadEhallSessionDump, saveEhallSession } from "./session.mjs";

const EHALL = "https://ehall.szu.edu.cn";
const SERVICE = "https://ehall.szu.edu.cn:443/amp/login";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function requestWith(jar, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Cookie: jar.headerFor(url), "User-Agent": UA, ...(opts.headers || {}) },
    redirect: "follow",
  });
  jar.addFromResponse(res, new URL(res.url).hostname.toLowerCase());
  return { status: res.status, text: await res.text(), url: res.url };
}

async function sessionAlive(jar) {
  try {
    const r = await requestWith(jar, `${EHALL}/jsonp/userInfo.json`);
    if (r.status !== 200) return false;
    return /"hasLogin"\s*:\s*true/.test(r.text);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 返回已登录的 CookieJar。缓存有效时零成本。
 * @param {{force?: boolean}} opts
 */
export async function getEhallJar({ force = false } = {}) {
  if (!force) {
    const dump = loadEhallSessionDump();
    if (dump) {
      const jar = new CookieJar().restore(dump);
      if (await sessionAlive(jar)) return { jar, cached: true };
    }
  }

  const cred = loadCredentials();
  if (!cred) throw new Error("缺少统一认证凭据：先跑 node scripts/save-credentials.mjs <账号> <密码>");

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await casLogin(cred.username, cred.password, SERVICE);
      if (!(await sessionAlive(r.jar))) throw new Error("登录后会话仍无效");
      saveEhallSession(r.jar);
      return { jar: r.jar, cached: false };
    } catch (e) {
      lastErr = e;
      // 401 = 短时间内重复登录触发风控。继续重试只会把窗口拖长，直接停。
      if (/401/.test(e.message)) {
        throw new Error(
          "统一认证返回 401（短时间内重复登录触发风控）。等 30–60 分钟再跑；" +
            "已有缓存时不要加 --relogin。"
        );
      }
      if (attempt < 3) await sleep(attempt * 5000);
      else break;
    }
  }
  throw lastErr;
}

/** 打开办事大厅应用，返回该应用的数据接口基址（含会话） */
export async function openApp(jar, appId) {
  const show = await requestWith(jar, `${EHALL}/appShow?appId=${appId}`);
  if (show.status !== 200) throw new Error(`打开应用失败 ${show.status}`);
  const base = show.url.split("/jwapp/")[0] + "/jwapp/sys";
  return { indexUrl: show.url, base };
}

/** 调用 jwapp 的 .do 接口（表单 POST，返回 JSON） */
export async function appPost(jar, base, sysName, path, body = "", referer) {
  const url = `${base}/${sysName}/modules/${path}`;
  const res = await requestWith(jar, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      ...(referer ? { Referer: referer } : {}),
    },
    body,
  });
  if (res.status !== 200) throw new Error(`${path} → HTTP ${res.status}`);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`${path} 返回的不是 JSON：${res.text.slice(0, 120)}`);
  }
}
