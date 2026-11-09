/**
 * 深圳大学教学管理系统（jwkw.szu.edu.cn）
 *
 * 这才是真正的教务系统。与办事大厅的 jwapp 不同，它对外暴露的是干净的
 * GET JSON 接口，不需要 jsessionid 拼 URL、也没有表单 POST 的坑：
 *
 *   GET /jwapp/sys/homeapp/api/home/currentUser.do                  当前用户 + 当前周次
 *   GET /jwapp/sys/homeapp/api/home/menus.do?userType=student        功能菜单
 *   GET /jwapp/sys/homeapp/api/home/kb/xnxq.do                       学年学期列表
 *   GET /jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=YYYY-MM-DD   某天属于第几周
 *   GET /jwapp/sys/homeapp/api/home/teachingSchedule/list.do?rq=&lxdm=student      当天课程
 *   GET /jwapp/sys/homeapp/api/home/student/exams.do?termCode=      考试安排
 *   GET /jwapp/sys/homeapp/api/home/announcement.do?userType=student 公告
 *   GET /jwapp/sys/homeapp/api/home/messages_pc.do?userType=student  消息
 *   GET /jwapp/sys/homeapp/api/home/student/applys.do                申请
 *
 * 注意：CAS service 必须是 https://jwkw.szu.edu.cn/jwapp/sys/homeapp/index.do，
 * 用办事大厅的 service 登录只会拿到 ehall 的会话，这个域仍然是游客。
 */
import { casLogin, CookieJar } from "./cas.mjs";
import {
  loadCredentials,
  loadSessionFile,
  saveSessionFile,
  JWKW_SESSION_FILE,
} from "./session.mjs";

const HOST = "jwkw.szu.edu.cn";
const BASE = `https://${HOST}`;
const SERVICE = `${BASE}/jwapp/sys/homeapp/index.do`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(jar, path) {
  const url = path.startsWith("http") ? path : BASE + path;
  const res = await fetch(url, {
    headers: { Cookie: jar.headerFor(url), "User-Agent": UA, Accept: "application/json, */*" },
  });
  jar.addFromResponse(res, HOST);
  return { status: res.status, text: await res.text() };
}

async function alive(jar) {
  try {
    const r = await get(jar, "/jwapp/sys/homeapp/api/home/currentUser.do");
    if (r.status !== 200) return false;
    const j = JSON.parse(r.text);
    return j.code === "0" && Boolean(j.datas?.userId);
  } catch {
    return false;
  }
}

export async function getJwkwJar({ force = false } = {}) {
  if (!force) {
    const dump = loadSessionFile(JWKW_SESSION_FILE);
    if (dump) {
      const jar = new CookieJar().restore(dump);
      if (await alive(jar)) return { jar, cached: true };
    }
  }

  const cred = await loadCredentials();
  if (!cred) throw new Error("缺少统一身份认证账号：先登录一次办事大厅，或用 SZU_USER / SZU_PASS 环境变量传入");

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await casLogin(cred.username, cred.password, SERVICE);
      if (!(await alive(r.jar))) throw new Error("登录后 jwkw 会话仍无效");
      saveSessionFile(JWKW_SESSION_FILE, r.jar);
      return { jar: r.jar, cached: false };
    } catch (e) {
      lastErr = e;
      if (/401/.test(e.message)) {
        throw new Error("统一认证返回 401（短时间重复登录触发风控），等 30–60 分钟再跑");
      }
      if (attempt < 2) await sleep(5000);
    }
  }
  throw lastErr;
}

/** 包一层，自动解 code/datas，接口异常时抛出可读错误 */
export async function api(jar, path) {
  const r = await get(jar, path);
  if (r.status !== 200) throw new Error(`${path.split("?")[0]} → HTTP ${r.status}`);
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new Error(`${path.split("?")[0]} 返回的不是 JSON`);
  }
  if (j.code !== "0") throw new Error(`${path.split("?")[0]} → code ${j.code} ${j.msg || ""}`);
  return j.datas;
}

export const endpoints = {
  currentUser: () => "/jwapp/sys/homeapp/api/home/currentUser.do",
  menus: () => "/jwapp/sys/homeapp/api/home/menus.do?userType=student",
  terms: () => "/jwapp/sys/homeapp/api/home/kb/xnxq.do",
  classWeek: (date) => `/jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=${date}`,
  scheduleOfDay: (date) =>
    `/jwapp/sys/homeapp/api/home/teachingSchedule/list.do?rq=${date}&lxdm=student`,
  exams: (termCode) => `/jwapp/sys/homeapp/api/home/student/exams.do?termCode=${termCode}`,
  announcements: () => "/jwapp/sys/homeapp/api/home/announcement.do?userType=student",
  messages: () => "/jwapp/sys/homeapp/api/home/messages_pc.do?userType=student",
  applys: () => "/jwapp/sys/homeapp/api/home/student/applys.do",
};

/**
 * 由「某天 + 该天所属教学周」反推第 1 周周一。
 * 教务的周次是校历算的，比拿开学日期猜可靠；用两个日期交叉验证更稳。
 */
export async function resolveWeek1Monday(jar, refDate = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoWeekday = (d) => (d.getDay() === 0 ? 7 : d.getDay());

  const w = Number((await api(jar, endpoints.classWeek(iso(refDate)))).classWeek);
  if (!Number.isFinite(w) || w < 1) throw new Error("拿不到教学周，无法定位第 1 周");

  const monday = new Date(
    refDate.getFullYear(),
    refDate.getMonth(),
    refDate.getDate() - ((w - 1) * 7 + (isoWeekday(refDate) - 1))
  );

  // 校验：往回走一周应该是上一周。第 1 周往回是假期，教务返回 0，属正常。
  const prev = Number(
    (await api(jar, endpoints.classWeek(iso(new Date(monday.getTime() - 7 * 864e5))))).classWeek
  );
  if (w > 1 && prev !== 0 && prev !== w - 1) {
    throw new Error(`周次推算自相矛盾（${iso(monday)} 前后差 ${prev} vs ${w - 1}），请用 --week1 指定`);
  }

  return { week1Monday: monday, currentWeek: w };
}
