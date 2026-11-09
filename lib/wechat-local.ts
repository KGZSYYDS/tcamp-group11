/**
 * 本机微信 → 结构化消息（服务端专用）
 *
 * 为什么放在服务端：微信 4.0 的库是加密 SQLite，浏览器读不了；而 WeFlow
 * 需要读本机密钥、调本地 exe，只能在 Node 里跑。网页跑在用户自己电脑上
 * （localhost），所以「服务端」其实就是「用户的电脑」，聊天正文不出这台机器。
 *
 * 换一台陌生电脑时，这里负责「找到它在哪」：WeFlow 可能装在任意目录，
 * 微信数据可能在 D 盘或别的盘符。所以路径不写死，按下面的顺序找：
 *   1. data/.weflow-config.json 里用户自己填的路径（最可靠）
 *   2. 环境变量 WEFLOW_EXE
 *   3. 常见安装位置
 *   4. 自动扫描（见 detectWeFlowCandidates）
 * 用户填过一次就记住，下次不用再填。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DATA_DIR = path.resolve("data");
const CONFIG_FILE = path.join(DATA_DIR, ".weflow-config.json");

/** 常见安装位置。用户自己填的路径优先，这些只是「猜」。 */
function commonExePaths(): string[] {
  const list: string[] = [
    "D:/Tools/WeFlow/weflow.cmd",
    "D:/Tools/WeFlow/weflow-v5.0.1-windows-x64/weflow.exe",
    "C:/Tools/WeFlow/weflow.cmd",
    "C:/Tools/WeFlow/weflow-v5.0.1-windows-x64/weflow.exe",
    path.join(process.cwd(), "tools/weflow/weflow.exe"),
  ];
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.USERPROFILE]) {
    if (!base) continue;
    list.push(path.join(base, "WeFlow", "weflow.exe"));
    list.push(path.join(base, "Programs", "WeFlow", "weflow.exe"));
  }
  return list;
}

interface WeFlowConfig {
  exePath?: string;
  /** 用户手动指定的微信数据目录（一般不用填，WeFlow 自己能找到） */
  wechatDir?: string;
  updatedAt?: string;
}

export function readConfig(): WeFlowConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as WeFlowConfig;
  } catch {
    return {};
  }
}

export function writeConfig(patch: WeFlowConfig) {
  const next = { ...readConfig(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** .cmd 只是壳，真正能干活的 exe 在它旁边 */
function resolveExe(p: string): string {
  if (/\.(cmd|bat)$/i.test(p)) {
    const dir = path.dirname(p);
    const exe = path.join(dir, "weflow-v5.0.1-windows-x64", "weflow.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return p;
}

/**
 * 在磁盘上扫一遍 WeFlow。只扫浅层目录（盘符根 + 一层），
 * 全盘递归在 Windows 上要几分钟，前端等不了。
 */
export function detectWeFlowCandidates(): { exe: string; from: string }[] {
  const found: { exe: string; from: string }[] = [];
  const seen = new Set<string>();
  const push = (p: string, from: string) => {
    if (!p) return;
    const exe = resolveExe(p);
    if (!fs.existsSync(exe) || seen.has(exe)) return;
    seen.add(exe);
    found.push({ exe, from });
  };

  const cfg = readConfig();
  if (cfg.exePath) push(cfg.exePath, "配置");
  if (process.env.WEFLOW_EXE) push(process.env.WEFLOW_EXE, "环境变量");
  for (const p of commonExePaths()) push(p, "常见位置");

  // 盘符根下的 Tools / 软件 目录：绝大多数人会解压到这种地方
  for (const drive of ["C", "D", "E", "F", "G", "H"]) {
    for (const sub of ["Tools", "tools", "Program Files", "Program Files (x86)", "软件", "Apps"]) {
      const dir = `${drive}:/${sub}`;
      if (!fs.existsSync(dir)) continue;
      // WeFlow / weflow
      for (const name of ["WeFlow", "weflow"]) {
        const d = path.join(dir, name);
        if (!fs.existsSync(d)) continue;
        push(path.join(d, "weflow.cmd"), `扫描 ${drive}:/${sub}`);
        push(path.join(d, "weflow.exe"), `扫描 ${drive}:/${sub}`);
        try {
          for (const inner of fs.readdirSync(d).slice(0, 20)) {
            const idir = path.join(d, inner);
            if (!fs.statSync(idir).isDirectory()) continue;
            push(path.join(idir, "weflow.exe"), `扫描 ${drive}:/${sub}`);
          }
        } catch {
          // 没权限就跳过
        }
      }
    }
  }
  return found;
}

export function findWeFlow(): string | null {
  const all = detectWeFlowCandidates();
  return all.length ? all[0].exe : null;
}

function envFor(exe: string) {
  const env = { ...process.env };
  if (!env.WEFLOW_HOME) {
    // exe 在 .../weflow-v5.0.1-windows-x64/ 下，配置在同级的 data
    const guess = path.resolve(path.dirname(exe), "..", "data");
    if (fs.existsSync(guess)) env.WEFLOW_HOME = guess;
  }
  return env;
}

function run(exe: string, args: string[], timeout = 120_000) {
  const r = spawnSync(exe, args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout,
    windowsHide: true,
    env: envFor(exe),
  });
  if (r.error) throw new Error(`调用 WeFlow 失败：${r.error.message}`);
  const stdout = (r.stdout || Buffer.alloc(0)).toString("utf8").trim();
  const stderr = (r.stderr || Buffer.alloc(0)).toString("utf8").trim();
  if (r.status !== 0) {
    throw new Error(`WeFlow 返回 ${r.status}：${(stderr || stdout).slice(0, 200)}`);
  }
  return { stdout, stderr };
}

// ---------- 微信数据目录探测 ----------

export interface WeChatDirInfo {
  dir: string;
  /** 目录里的账号目录名（形如 wxid_xxx_1234），只露尾部 */
  accounts: string[];
  /** 目录是否像微信 4.0 的 xwechat_files */
  v4: boolean;
  /** WeFlow 现在用的就是这个目录 */
  active: boolean;
  /** 从哪找到的：weflow=WeFlow 配置 / registry=注册表 / 默认 / 扫描 */
  from: string;
}

/** 一个目录像不像微信的数据根：下面得有 wxid_* 账号目录 */
function probeRoot(dir: string): { accounts: string[]; v4: boolean } | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const accounts = names.filter((n) => /^wxid_/i.test(n));
  if (!accounts.length) return null;
  let v4 = false;
  try {
    // 4.0 的账号目录下是 db_storage；3.x 是 Msg/ 那一套
    v4 = fs.existsSync(path.join(dir, accounts[0], "db_storage"));
  } catch {
    // 读不到就当 3.x
  }
  return { accounts, v4 };
}

/**
 * 微信自己把「文件存储位置」记在注册表里（3.x 在 WeChat，4.0 在 Weixin）。
 * 用户改过存储位置时，这是唯一能直接问出来的地方。
 */
function registryPaths(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (const key of ["HKCU\\Software\\Tencent\\WeChat", "HKCU\\Software\\Tencent\\Weixin"]) {
    try {
      const r = spawnSync("reg", ["query", key, "/v", "FileSavePath"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      if (r.status !== 0 || !r.stdout) continue;
      const m = r.stdout.match(/FileSavePath\s+REG_\w+\s+(.+)/);
      const v = m?.[1]?.trim();
      if (v) out.push(v.replace(/^"|"$/g, ""));
    } catch {
      // 没有这个键就算了
    }
  }
  return out;
}

/** WeFlow 当前配置的微信目录（只读 db_path，绝不读 config list —— 那里有密钥） */
export function weflowDbPath(exe: string): string | null {
  try {
    const j = JSON.parse(run(exe, ["--json", "config", "get", "db_path"], 15_000).stdout);
    const v = j?.data;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase().replace(/[\\/]+$/, "") ===
  path.resolve(b).toLowerCase().replace(/[\\/]+$/, "");

/**
 * 找微信把聊天数据放在哪。
 *
 * 「陌生电脑」是这个函数的全部理由：微信的存储位置是可改的，用户常常改到
 * D 盘、甚至中文目录下，光靠猜默认路径会一无所获。按可信度依次问：
 *   1. WeFlow 配置里的 db_path（它已经在用了，最权威）
 *   2. 注册表 FileSavePath（微信自己记的）
 *   3. 默认位置：文档 / 盘符根
 *   4. 浅扫各盘一级目录，名字带 微信/wechat/weixin 的往里再看一层
 * 每个候选都要能读出 wxid_* 账号目录才算数，空壳目录不返回。
 */
export function detectWeChatDirs(exe?: string | null): WeChatDirInfo[] {
  const home = os.homedir();
  const candidates: { dir: string; from: string }[] = [];
  const push = (dir: string, from: string) => {
    if (dir) candidates.push({ dir, from });
  };

  const configured = exe ? weflowDbPath(exe) : null;
  if (configured) push(configured, "weflow");

  for (const d of registryPaths()) push(d, "registry");

  for (const d of [home, path.join(home, "Documents"), path.join(home, "OneDrive", "Documents")]) {
    push(path.join(d, "xwechat_files"), "默认");
    push(path.join(d, "WeChat Files"), "默认");
  }
  for (const drive of ["C", "D", "E", "F", "G", "H"]) {
    push(`${drive}:/xwechat_files`, "默认");
    push(`${drive}:/WeChat Files`, "默认");
  }

  // 浅扫：一级目录名带关键词的，检查它本身和它下面一层
  for (const drive of ["C", "D", "E", "F", "G", "H"]) {
    const root = `${drive}:/`;
    let top: string[] = [];
    try {
      if (!fs.existsSync(root)) continue;
      top = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of top) {
      if (!/微信|wechat|weixin/i.test(name)) continue;
      const d = path.join(root, name);
      push(d, `扫描 ${drive}:`);
      try {
        for (const inner of fs.readdirSync(d).slice(0, 20)) {
          const idir = path.join(d, inner);
          if (fs.statSync(idir).isDirectory()) push(idir, `扫描 ${drive}:`);
        }
      } catch {
        // 没权限跳过
      }
    }
  }

  const out: WeChatDirInfo[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = path.resolve(c.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Backup 里也有一个完整的 wxid_ 目录：指向它「能连上」，但读到的是旧快照，
    // 比直接报错更难发现。排除掉，省得用户踩这个坑。
    if (/(^|[\\/])backup([\\/]|$)|备份/i.test(c.dir)) continue;
    const probe = probeRoot(c.dir);
    if (!probe) continue;
    out.push({
      dir: c.dir,
      accounts: probe.accounts.map((a) => (a.length > 14 ? "…" + a.slice(-10) : a)),
      v4: probe.v4,
      active: Boolean(configured && samePath(configured, c.dir)),
      from: c.from,
    });
  }

  // 正在用的排最前
  return out.sort((a, b) => Number(b.active) - Number(a.active));
}

/**
 * 用户指定一个微信目录 → 先验证里面真有账号，再写进 WeFlow 配置。
 *
 * 只改 db_path 和 wxid，不碰密钥；改完下一次 `db test` 就知道能不能打开。
 * 多个账号时选第一个（截图/演示场景够用），并把数量回给前端提示。
 */
export function setWeChatDir(
  exe: string,
  dir: string
): { ok: boolean; accounts: number; wxid?: string; message?: string } {
  if (!fs.existsSync(dir)) return { ok: false, accounts: 0, message: "这个目录不存在" };

  let accounts: { wxid?: string }[] = [];
  try {
    const j = JSON.parse(run(exe, ["--json", "db", "scan", dir], 120_000).stdout);
    accounts = Array.isArray(j?.data?.accounts) ? j.data.accounts : [];
  } catch (e) {
    return { ok: false, accounts: 0, message: e instanceof Error ? e.message : "扫描失败" };
  }
  if (!accounts.length) {
    return {
      ok: false,
      accounts: 0,
      message: "这个目录里没有微信账号（没找到 wxid_* 文件夹），可能选错了一层",
    };
  }

  try {
    run(exe, ["--json", "config", "set", "db_path", dir], 15_000);
    const wxid = accounts[0]?.wxid;
    if (wxid) run(exe, ["--json", "config", "set", "wxid", wxid], 15_000);
    invalidateStatus();
    return { ok: true, accounts: accounts.length, wxid };
  } catch (e) {
    return { ok: false, accounts: accounts.length, message: e instanceof Error ? e.message : "写入配置失败" };
  }
}

// ---------- 状态 ----------

export interface WeFlowStatus {
  available: boolean;
  connected: boolean;
  version: string | null;
  accountHint: string | null;
  error?: string;
  /** 诊断分步，前端据此显示「卡在第几步」 */
  stage: "no-exe" | "no-data" | "no-key" | "ready";
  /** 找到的 exe 候选（给「是不是这个」用） */
  exePath: string | null;
  /** 微信数据目录探测结果，供引导用户确认 */
  wechatDirs: WeChatDirInfo[];
  /** 有没有人手动指定过路径 */
  configured: boolean;
}

let cached: { at: number; value: WeFlowStatus } | null = null;

export function weflowStatus(force = false): WeFlowStatus {
  if (!force && cached && Date.now() - cached.at < 20_000) return cached.value;

  const exe = findWeFlow();
  const dirs = detectWeChatDirs(exe);
  const hasActive = dirs.some((d) => d.active);
  const configured = Boolean(readConfig().exePath);

  let value: WeFlowStatus;
  if (!exe) {
    value = {
      available: false,
      connected: false,
      version: null,
      accountHint: null,
      stage: "no-exe",
      exePath: null,
      wechatDirs: dirs,
      configured,
      error: "这台机器上没找到 WeFlow",
    };
  } else {
    try {
      const ver = run(exe, ["--version"], 20_000).stdout.split("\n")[0];
      const j = JSON.parse(run(exe, ["--json", "db", "test"], 60_000).stdout);
      const account: string = j?.data?.accountDir || "";
      const tail = account.split(/[\\/]/).filter(Boolean).pop() || "";
      const connected = Boolean(j?.data?.connected);
      value = {
        available: true,
        connected,
        version: ver.replace(/^weflow\s*/i, ""),
        accountHint: tail ? tail.slice(-6) : null,
        // 连不上时先看「有没有指向正确的目录」：目录都没找对，让用户去重登微信是白费
        stage: connected ? "ready" : hasActive ? "no-key" : "no-data",
        exePath: exe,
        wechatDirs: dirs,
        configured,
        error: connected
          ? undefined
          : hasActive
            ? "WeFlow 找到了，但打不开微信数据库（多半是密钥过期）"
            : "WeFlow 找到了，但还没确定微信的聊天记录存在哪个文件夹",
      };
    } catch (e) {
      value = {
        available: true,
        connected: false,
        version: null,
        accountHint: null,
        stage: hasActive ? "no-key" : "no-data",
        exePath: exe,
        wechatDirs: dirs,
        configured,
        error: e instanceof Error ? e.message : "WeFlow 探测失败",
      };
    }
  }

  cached = { at: Date.now(), value };
  return value;
}

export function invalidateStatus() {
  cached = null;
}

/**
 * 后台跑一次 `key db --save`。
 *
 * 这一步需要用户在微信里**退出重登**，WeFlow 会等他登录完成后自动读密钥，
 * 最长 600 秒。所以不能同步等（前端会超时），只能起一个后台进程，
 * 前端轮询 status 看 connected 变没变。
 *
 * 输出里有密钥相关信息，**一律不返回给前端**，只报「在等」「好了」「失败」。
 */
let keyJob: { startedAt: number; done: boolean; ok: boolean; message: string } | null = null;

export function startKeyJob(): { started: boolean; message: string } {
  const exe = findWeFlow();
  if (!exe) return { started: false, message: "没找到 WeFlow" };
  if (keyJob && !keyJob.done) return { started: true, message: "已经在等了，别重复点" };

  keyJob = { startedAt: Date.now(), done: false, ok: false, message: "正在等待微信重新登录…" };
  const child = spawn(exe, ["key", "db", "--save", "--timeout", "600"], {
    env: envFor(exe),
    windowsHide: true,
    stdio: "ignore", // 输出可能含密钥，直接丢弃
  });
  child.on("exit", (code) => {
    if (keyJob) {
      keyJob.done = true;
      keyJob.ok = code === 0;
      keyJob.message = code === 0 ? "密钥已更新" : `WeFlow 退出码 ${code}，可能超时或微信没重登`;
    }
    invalidateStatus();
  });
  child.on("error", (e) => {
    if (keyJob) {
      keyJob.done = true;
      keyJob.ok = false;
      keyJob.message = `启动失败：${e.message}`;
    }
  });
  return { started: true, message: "已开始等待，请在微信里退出登录再重新登录" };
}

export function keyJobState() {
  return keyJob;
}

// ---------- 会话 / 导出 ----------

export interface WeChatGroup {
  id: string;
  name: string;
}

export function listGroups(exe: string): WeChatGroup[] {
  const { stdout } = run(exe, ["--json", "chat", "contacts", "--parsed"], 90_000);
  const j = JSON.parse(stdout);
  const arr = (Array.isArray(j) ? j : j?.data) || [];
  if (!Array.isArray(arr)) throw new Error("WeFlow 返回的联系人列表格式不对");
  return arr
    .filter((x: { type?: string }) => x.type === "group")
    .map((x: { username: string; displayName?: string; nickname?: string }) => ({
      id: String(x.username),
      name: String(x.displayName || x.nickname || x.username),
    }))
    .filter((g: WeChatGroup) => g.id && g.name);
}

export interface ExportResult {
  file: string;
  count: number;
  dir: string;
}

export function exportGroup(exe: string, groupId: string, start: string, end: string): ExportResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "szu-wx-"));
  try {
    const { stdout } = run(
      exe,
      ["--json", "export", "messages", groupId, "--out", dir, "--format", "json", "--start", start, "--end", end],
      180_000
    );
    const info = JSON.parse(stdout)?.data;
    const file: string | undefined = info?.out;
    if (!file || !fs.existsSync(file)) throw new Error("导出完成但没有拿到文件");
    return { file, count: Number(info?.count) || 0, dir };
  } catch (e) {
    cleanup([dir]);
    throw e;
  }
}

export function cleanup(dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 上文件偶尔还被占用，删不掉就留着，不影响结果
    }
  }
}

/** 群名打分：只用于排序和默认勾选 */
const GOOD_WORDS: [number, string[]][] = [
  [4, ["通知", "禁言", "公告", "班群", "班级", "级群", "年级群", "课程群", "课群"]],
  [3, ["辅导员", "导生", "教务", "教学", "班委", "团支", "党支部", "社团", "战队", "项目组"]],
  [2, ["学院", "专业", "新生", "深大", "深圳大学", "大学", "课程", "考试", "讲座", "培训"]],
];
const BAD_WORDS = [
  "家教", "闲置", "二手", "福利", "粉丝", "会员", "尊享", "优惠", "折扣", "团购",
  "外卖", "奶茶", "糖水", "麦当劳", "奈雪", "拼车", "租房", "代购", "兼职", "招聘",
  "相亲", "交友", "游戏", "开黑", "水群", "吹水", "娱乐", "资源分享", "广告",
];

export function scoreGroup(name: string): number {
  let score = 0;
  for (const [w, words] of GOOD_WORDS) for (const k of words) if (name.includes(k)) score += w;
  for (const k of BAD_WORDS) if (name.includes(k)) score -= 10;
  return score;
}
