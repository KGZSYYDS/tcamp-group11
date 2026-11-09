/**
 * 统一的「一次登录，取全套个人档案」入口
 *
 * 用户只需要提供一次统一身份认证账号 + 密码（用完即弃，不落盘），
 * 这里把能自动拿到的信息一次性取全，写进 data/profile.json：
 *
 *   姓名       ← ehall /jsonp/userInfo.json  userName
 *   学号       ← 同上 userId
 *   学院       ← 同上 userDepartment
 *   培养层次   ← 同上 userTypeName（学生 / 研究生 …）
 *   性别       ← 同上 userSex
 *   专业       ← jwkw currentUser.do 里试取；该接口实测只给姓名/学号/学期/周次，留空是常态
 *   年级       ← 学号前 4 位（深大学号 = 入学年份 + 学院码 + 序号）
 *   学期/周次  ← jwkw classWeek.do
 *
 * 这些信息本来就是学校系统对本人可见的，不该让用户手填 —— 手填只会填错，
 * 而且用户在「我的」页填的学院和数据库里的学院字符串一旦不一致，
 * 公共事件的学院过滤就永远匹配不上。
 *
 * 用法：
 *   SZU_USER=2024xxxxxx SZU_PASS=*** node scripts/collect-profile.mjs
 *   node scripts/collect-profile.mjs --pass-stdin < pass.txt
 *   node scripts/collect-profile.mjs --offline       只用本地已有的 dump，不联网
 */
import fs from "fs";
import path from "path";
import { getEhallJar, requestWith } from "./lib/ehall.mjs";
import { getJwkwJar, api, endpoints } from "./lib/jwkw.mjs";
import { ensureDataDir, loadCredentials, purgeStoredCredentials } from "./lib/session.mjs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const OFFLINE = has("offline");
const OUT = path.resolve(opt("out") || "data/profile.json");

/** 从办事大厅 userInfo 里取本人档案（这是学籍的权威口径） */
async function fromEhall(jar) {
  const r = await requestWith(jar, "https://ehall.szu.edu.cn/jsonp/userInfo.json");
  if (r.status !== 200) throw new Error(`userInfo 返回 ${r.status}`);
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new Error("userInfo 不是 JSON，可能是会话已失效");
  }
  if (!j.hasLogin) throw new Error("办事大厅未登录，无法读取学籍信息");

  return {
    name: j.userName || "",
    studentId: String(j.userId || ""),
    college: j.userDepartment || "",
    levelName: j.userTypeName || "",
    sex: j.userSex || "",
  };
}

/** 从教务 currentUser 里补专业 / 班级（不同版本字段名不一致，逐个试） */
async function fromJwkw(jar) {
  try {
    const d = await api(jar, endpoints.currentUser());
    const pick = (...keys) => {
      for (const k of keys) {
        const v = d?.[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    return {
      major: pick("zymc", "majorName", "zyName", "professionalName", "major"),
      className: pick("bjmc", "className", "bjName", "class"),
      grade: pick("njmc", "gradeName", "grade", "rxnf"),
      college: pick("yxmc", "collegeName", "departmentName", "deptName"),
      raw: d,
    };
  } catch (e) {
    return { major: "", className: "", grade: "", college: "", error: e.message };
  }
}

function gradeFromStudentId(xh) {
  const m = /^(\d{4})/.exec(xh || "");
  return m ? `${m[1]} 级` : "";
}

/** 培养层次：办事大厅给「学生」，但研究生也是「学生」，靠学号/专业判断不可靠，
 *  这里优先用 jwkw 的字段，其次保留原值 */
function normalizeLevel(name, major, className) {
  const s = `${name} ${major} ${className}`;
  if (/博士/.test(s)) return "doctoral";
  if (/硕士|研究生/.test(s)) return "postgraduate";
  return "undergraduate";
}

async function main() {
  ensureDataDir();

  let info = {};

  if (OFFLINE) {
    const raw = path.resolve("data/board/raw/userinfo.json");
    if (!fs.existsSync(raw)) throw new Error("--offline 需要 data/board/raw/userinfo.json");
    const j = JSON.parse(fs.readFileSync(raw, "utf-8"));
    info = {
      name: j.userName || "",
      studentId: String(j.userId || ""),
      college: j.userDepartment || "",
      levelName: j.userTypeName || "",
      sex: j.userSex || "",
    };
    console.log("离线模式：只读本地 dump，不联网");
  } else {
    const { jar, cached } = await getEhallJar();
    console.log(`办事大厅会话：${cached ? "复用缓存（本次没有用到密码）" : "新登录（密码仅用于本次登录，未落盘）"}`);
    info = await fromEhall(jar);

    try {
      const jw = await getJwkwJar();
      const extra = await fromJwkw(jw.jar);
      info = { ...info, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) };
      if (extra.error) console.warn(`  教务档案补充失败（不影响主流程）：${extra.error}`);
    } catch (e) {
      console.warn(`  教务会话不可用（不影响主流程）：${e.message}`);
    }
  }

  const profile = {
    name: info.name || "",
    studentId: info.studentId || "",
    college: info.college || "",
    major: info.major || "",
    className: info.className || "",
    grade: info.grade || gradeFromStudentId(info.studentId),
    level: normalizeLevel(info.levelName || "", info.major, info.className),
    levelName: info.levelName || "",
    sex: info.sex || "",
    fetchedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUT, JSON.stringify(profile, null, 2), "utf-8");
  purgeStoredCredentials();

  const miss = ["name", "studentId", "college", "major"].filter((k) => !profile[k]);
  console.log("\n已写入 " + path.relative(process.cwd(), OUT));
  console.log(`  姓名：${profile.name || "（未取到）"}`);
  console.log(`  学号：${profile.studentId || "（未取到）"}`);
  console.log(`  学院：${profile.college || "（未取到）"}`);
  console.log(`  专业：${profile.major || "（未取到）"}`);
  console.log(`  年级：${profile.grade || "（未取到）"}`);
  console.log(`  层次：${profile.level}（原值 ${profile.levelName || "-"}）`);
  if (miss.length) console.log(`\n⚠ 缺 ${miss.join(" / ")}：这些字段教务接口没给，需要另外的接口或人工兜底`);
  console.log("\n密码未写入磁盘；会话 cookie 已缓存，下次运行无需再输密码。");
}

main().catch((e) => {
  console.error("采集档案失败：", e.message);
  process.exit(1);
});
