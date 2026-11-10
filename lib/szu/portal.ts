/**
 * 从学校系统取「我自己的」数据：课表 + 档案 + 第 1 周锚点。
 *
 * 这两块数据在两个系统里，各取所长：
 *   课表本体 ← 办事大厅「我的课表」(ehall / jwapp / wdkb)，字段最全（周次掩码、教室、教师）
 *   周次锚点 ← 教学管理系统 (jwkw)，它是校历的权威口径
 *
 * 为什么不都用 ehall：wdkb 的 dqzc.do 返回的周次比教务多一周（实测 11/8 它给 11，
 * 教务给 10 且页面写「第10周 11/2~11/8」）。差这一周，整学期课表全错位。
 *
 * 这些函数原来是 scripts/collect-timetable.mjs 和 collect-profile.mjs 里的私有实现，
 * 只给命令行用。网页要「登录即出课表」就必须能复用，所以抽到这里，
 * 保持零依赖（不读环境变量、不写文件），由调用方决定数据去哪。
 */
import fs from "node:fs";
import path from "node:path";
import { CookieJar, requestWith } from "./cas";

export const EHALL = "https://ehall.szu.edu.cn";
export const JWKW = "https://jwkw.szu.edu.cn";
export const EHALL_SERVICE = `${EHALL}:443/amp/login`;
export const JWKW_SERVICE = `${JWKW}/jwapp/sys/homeapp/index.do`;
const APP_ID = "4770397878132218";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const DEFAULT_PERIODS: Record<number, [string, string]> = {
  1: ["08:30", "09:10"],
  2: ["09:15", "09:55"],
  3: ["10:15", "10:55"],
  4: ["11:00", "11:40"],
  5: ["11:45", "12:25"],
  6: ["13:30", "14:10"],
  7: ["14:15", "14:55"],
  8: ["15:00", "15:40"],
  9: ["16:00", "16:40"],
  10: ["16:45", "17:25"],
  11: ["19:00", "20:20"],
  12: ["19:00", "20:20"],
  13: ["20:30", "21:45"],
  14: ["20:30", "21:45"],
};

// ---------- 日期工具 ----------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const isoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

/** 会话已失效时各接口给的东西五花八门（登录页 HTML / hasLogin:false），统一在这里判 */
function assertJson(text: string, what: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} 返回的不是 JSON，登录态可能已失效`);
  }
}

/**
 * GET 并把重定向链跟完，**每一跳的 Set-Cookie 都收进 jar**。
 *
 * 不能用 fetch 的 redirect:"follow"：那样只能看到最后一跳的响应头，
 * 而办事大厅/教务经常是「302 时种会话 cookie、落到 200 的页面本身不再种」，
 * 中间这一跳丢掉，后面所有请求都是未登录状态。
 */
async function getFollowing(jar: CookieJar, url: string, headers: Record<string, string> = {}) {
  let current = url;
  for (let i = 0; i < 10; i++) {
    const res = await requestWith(jar, current, { headers });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      current = new URL(next, current).toString();
      continue;
    }
    return { status: res.status, text: await res.text(), url: current };
  }
  throw new Error(`重定向超过 10 跳，已中止：${url}`);
}

// ---------- 办事大厅 / 课表 ----------

export async function openTimetableApp(jar: CookieJar) {
  const show = await getFollowing(jar, `${EHALL}/appShow?appId=${APP_ID}`);
  if (show.status !== 200) throw new Error(`打开课表应用失败（HTTP ${show.status}）`);
  const base = show.url.split("/jwapp/")[0] + "/jwapp/sys";
  return base;
}

async function appPost(jar: CookieJar, base: string, pathname: string, body = "") {
  const url = `${base}/wdkb/modules/${pathname}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: jar.headerFor(url),
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
    body,
    redirect: "follow",
    cache: "no-store",
  });
  jar.addFromResponse(res, new URL(url).hostname.toLowerCase());
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${pathname} → HTTP ${res.status}`);
  return assertJson(text, pathname);
}

export async function fetchTerm(jar: CookieJar, base: string) {
  const r = await appPost(jar, base, "jshkcb/dqxnxq.do");
  const row = r?.datas?.dqxnxq?.rows?.[0];
  if (!row) throw new Error("拿不到当前学年学期");
  return { code: row.DM as string, name: (row.MC as string) || (row.DM as string) };
}

export async function fetchStudentId(jar: CookieJar) {
  try {
    const r = await getFollowing(jar, `${EHALL}/jsonp/userInfo.json`);
    const j = assertJson(r.text, "userInfo");
    // 只能认 userId 键。曾经用 /\d{10}/ 扫全文，命中了控件 id 里的 0800151102，
    // 格式完全合法所以位数校验拦不住，导致学号一直是错的。
    return j.userId ? String(j.userId) : "";
  } catch {
    return "";
  }
}

export async function fetchSchedule(
  jar: CookieJar,
  base: string,
  termCode: string,
  week: number,
  xh: string
) {
  const body = new URLSearchParams({
    XNXQDM: termCode,
    XH: xh,
    SKZC: String(week || 1),
  });
  const r = await appPost(jar, base, "xskcb/xskcb.do", body.toString());
  const rows = r?.datas?.xskcb?.rows || [];
  if (!rows.length) throw new Error("课表为空：可能学期参数不对，或本学期没有排课");
  return rows as Record<string, string>[];
}

// ---------- 教务（周次 + 档案补充） ----------

async function jwkwGet(jar: CookieJar, pathname: string) {
  const url = `${JWKW}${pathname}`;
  const res = await fetch(url, {
    headers: {
      Cookie: jar.headerFor(url),
      "User-Agent": UA,
      Accept: "application/json, */*",
    },
    redirect: "follow",
    cache: "no-store",
  });
  jar.addFromResponse(res, "jwkw.szu.edu.cn");
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${pathname.split("?")[0]} → HTTP ${res.status}`);
  const j = assertJson(text, pathname.split("?")[0]);
  if (j.code !== "0") throw new Error(`${pathname.split("?")[0]} → code ${j.code} ${j.msg || ""}`);
  return j.datas as Record<string, unknown>;
}

export async function jwkwAlive(jar: CookieJar) {
  try {
    const d = await jwkwGet(jar, "/jwapp/sys/homeapp/api/home/currentUser.do");
    return Boolean(d?.userId);
  } catch {
    return false;
  }
}

export async function ehallAlive(jar: CookieJar) {
  try {
    const r = await getFollowing(jar, `${EHALL}/jsonp/userInfo.json`);
    return /"hasLogin"\s*:\s*true/.test(r.text);
  } catch {
    return false;
  }
}

/** 由「某天 + 该天属于第几周」反推第 1 周周一，并用上一周交叉校验 */
export async function resolveWeek1Monday(jar: CookieJar, refDate = new Date()) {
  const today = await jwkwGet(
    jar,
    `/jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=${iso(refDate)}`
  );
  const w = Number(today.classWeek);
  if (!Number.isFinite(w) || w < 1) throw new Error("教务没给出教学周，无法定位第 1 周");

  const monday = new Date(
    refDate.getFullYear(),
    refDate.getMonth(),
    refDate.getDate() - ((w - 1) * 7 + (isoWeekday(refDate) - 1))
  );

  // 第 1 周的上一周是假期，教务返回 0，属正常，不能当成「差一周」报错
  try {
    const prev = await jwkwGet(
      jar,
      `/jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=${iso(addDays(monday, -7))}`
    );
    const pw = Number(prev.classWeek);
    if (w > 1 && pw !== 0 && pw !== w - 1) {
      throw new Error(`周次推算自相矛盾（${iso(monday)} 上一周是第 ${pw} 周，应为第 ${w - 1} 周）`);
    }
  } catch (e) {
    // 只有「自相矛盾」才向上抛，接口本身失败就当校验不成立
    if (e instanceof Error && e.message.includes("自相矛盾")) throw e;
  }

  return { week1Monday: monday, currentWeek: w };
}

// ---------- 档案 ----------

export interface SzuProfile {
  name: string;
  studentId: string;
  college: string;
  major: string;
  className: string;
  grade: string;
  level: "undergraduate" | "postgraduate" | "doctoral";
  levelName: string;
  sex: string;
}

function gradeFromStudentId(xh: string) {
  const m = /^(\d{4})/.exec(xh || "");
  return m ? `${m[1]} 级` : "";
}

function normalizeLevel(name: string, major: string, className: string): SzuProfile["level"] {
  const s = `${name} ${major} ${className}`;
  if (/博士/.test(s)) return "doctoral";
  if (/硕士|研究生/.test(s)) return "postgraduate";
  return "undergraduate";
}

export async function fetchProfile(jar: CookieJar): Promise<SzuProfile> {
  const r = await getFollowing(jar, `${EHALL}/jsonp/userInfo.json`);
  const j = assertJson(r.text, "userInfo");
  if (!j.hasLogin) throw new Error("办事大厅未登录，读不到学籍信息");

  let major = "";
  let className = "";
  let grade = "";

  // 教务补充专业/班级。失败了不影响主流程——这几个字段只是用来给公共事件做匹配。
  try {
    const d = await jwkwGet(jar, "/jwapp/sys/homeapp/api/home/currentUser.do");
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = d?.[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    major = pick("zymc", "majorName", "zyName", "professionalName", "major");
    className = pick("bjmc", "className", "bjName", "class");
    grade = pick("njmc", "gradeName", "grade", "rxnf");
  } catch {
    /* 教务不可用时留空 */
  }

  const studentId = String(j.userId || "");
  const levelName = String(j.userTypeName || "");

  return {
    name: String(j.userName || ""),
    studentId,
    college: String(j.userDepartment || ""),
    major,
    className,
    grade: grade || gradeFromStudentId(studentId),
    level: normalizeLevel(levelName, major, className),
    levelName,
    sex: String(j.userSex || ""),
  };
}

// ---------- 展开成日历事件 ----------

function loadPeriods(): Record<number, [string, string]> {
  try {
    const f = path.resolve("data/timetable-periods.json");
    if (fs.existsSync(f)) {
      return { ...DEFAULT_PERIODS, ...JSON.parse(fs.readFileSync(f, "utf-8")) };
    }
  } catch {
    /* 用默认作息 */
  }
  return DEFAULT_PERIODS;
}

export interface TimetableEvent {
  kind: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  course: string;
  location: string | null;
  teacher: string | null;
  week: number;
  periods: string;
}

/**
 * 周次掩码 → 逐周的具体日期。
 * 掩码第 n 位为 "1" 表示第 n 周上这门课；单双周天然体现在掩码里，不用另判。
 */
export function expandSchedule(rows: Record<string, string>[], week1Monday: Date) {
  const periods = loadPeriods();
  const events: TimetableEvent[] = [];

  for (const r of rows) {
    const mask = String(r.SKZC || "");
    const weekday = Number(r.SKXQ);
    const ks = Number(r.KSJC);
    const js = Number(r.JSJC);
    const p1 = periods[ks];
    const p2 = periods[js];
    if (!mask || !weekday || !p1 || !p2) continue;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== "1") continue;
      const week = i + 1;
      const date = addDays(week1Monday, (week - 1) * 7 + (weekday - 1));
      events.push({
        kind: "other",
        title: r.KCM,
        // 本机 JSON 用不带时区的本地时间串，前端 new Date 按本地解析，避免时区偏移
        startAt: `${iso(date)}T${p1[0]}:00`,
        endAt: `${iso(date)}T${p2[1]}:00`,
        allDay: false,
        course: r.KCM,
        location: r.JASMC || null,
        teacher: r.SKJS || null,
        week,
        periods: `${ks}-${js}`,
      });
    }
  }

  return events.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export interface TimetablePayload {
  format: "szu-calendar-timetable";
  version: number;
  term: string;
  termName: string;
  week1Monday: string;
  currentWeek: number | null;
  courses: string[];
  counts: { courses: number; sessions: number };
  generatedAt: string;
  profile: SzuProfile;
  events: TimetableEvent[];
}

/**
 * 一次走完：拿学期 → 拿当前周 → 拉课表 → 定时段 → 展开。
 * week1 由教务给，拿不到就退化成「按当前周倒推」，并把这个事实告诉调用方。
 */
export async function collectTimetable(jar: CookieJar) {
  const base = await openTimetableApp(jar);
  const term = await fetchTerm(jar, base);
  const xh = await fetchStudentId(jar);

  let currentWeek: number | null = null;
  let week1Monday: Date | null = null;
  let warning: string | undefined;

  try {
    if (await jwkwAlive(jar)) {
      const r = await resolveWeek1Monday(jar);
      week1Monday = r.week1Monday;
      currentWeek = r.currentWeek;
    }
  } catch (e) {
    warning = e instanceof Error ? e.message : "教务周次不可用";
  }

  if (!week1Monday) {
    // 没拿到校历就不能算课表：宁可报错，也别给一份整体偏一周的日历
    throw new Error(
      `拿不到教务校历（${warning || "jwkw 会话无效"}），课表日期会整体错位，已中止`
    );
  }

  const rows = await fetchSchedule(jar, base, term.code, currentWeek || 1, xh);
  const events = expandSchedule(rows, week1Monday);
  const courses = [...new Set(rows.map((r) => r.KCM))];

  return {
    rows: rows.length,
    payload: {
      format: "szu-calendar-timetable" as const,
      version: 1,
      term: term.code,
      termName: term.name,
      week1Monday: iso(week1Monday),
      currentWeek,
      courses,
      counts: { courses: courses.length, sessions: events.length },
      generatedAt: new Date().toISOString(),
      events,
    },
  };
}
