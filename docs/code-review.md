# 代码通读与问题清单（2026-11-09）

基于 `e0278e0`。范围：`app/` 全部 13 个 route、`components/` 全部 12 个组件、`lib/` 全部模块。
目的：给你一份「改哪里、为什么、怎么改」的对照表，不代替你的判断。

---

## 一、三层数据模型（改代码前先记住这条线）

| 层 | 存哪 | 谁写 | 谁读 |
|---|---|---|---|
| ① 公共数据 | 云 `events`（`scope != personal`）+ `profiles` | `scripts/ingest-notices.mjs` 直写 REST；UI 里「全校/学院/年级」事件也写这里 | `listEvents()`、`getProfile()` |
| ② 个人数据 | 浏览器 localStorage，**六个 key** | 见下表 | 各面板 `load*()` 同步读 |
| ③ 交换文件 | `timetable-*.json` / `meetings-*.json` | 本机脚本生成 | `importFile()` 导入后落 ② |

②的 key 全集：

```
szu-calendar:timetable:v1   课表（含 profile 副本）
szu-calendar:personal:v1    群聊排出的会议/截止
szu-calendar:ddls:v1        作业 DDL（手动 + 畅课 + 粘贴）
szu-calendar:checkins:v1    签到
szu-calendar:my-events:v1   日历里手动加的「仅自己」
szu-calendar:ddl-done:v1    公共截止的「我交了」勾选
szu-cal-hidden              日历里隐藏的条目（← 唯一不合命名规范的一个）
```

**关键约束：不要往云库写 personal。** `listEvents()` 用 `.neq("scope","personal")` 挡历史脏数据，
`CalendarPanel` 的 `own` 只认 `ownerId === currentUserId`，游客态传空串。这条线是完整的，别打破。

---

## 二、后端：13 个接口

| 路由 | 方法 | 校验 | 外部依赖 | 副作用 |
|---|---|---|---|---|
| `/api/auth/session` | GET / DELETE | 只验签 cookie | 无 | 清 cookie |
| `/api/auth/szu` | POST | 学号 `^\d{6,16}$` + 非空密码 | authserver → ehall → jwkw | 签 cookie、存 ehall/jwkw jar |
| `/api/szu/timetable` | POST | cookie + `ehallAlive` | ehall / jwkw | 无（只读） |
| `/api/lms/login` | POST / DELETE | 非空 | lms 三跳 CAS | 存 `data/.lms-session.json` |
| `/api/lms/status` | GET | 无 | 读文件 mtime | 无 |
| `/api/lms/ddls` | GET | 有 jar | `/api/todos` + `/api/my-courses` | 无 |
| `/api/wechat/status` | GET | 无 | **spawnSync WeFlow** | 无（见 P0-2） |
| `/api/wechat/config` | GET / POST | 路径存在 + 正则 | 磁盘扫描、`db scan` | 写 `.weflow-config.json`、改 WeFlow 配置 |
| `/api/wechat/groups` | GET | `available` | `chat contacts` | 无 |
| `/api/wechat/key` | GET / POST | 无 | 后台 `key db --save` | 起子进程 |
| `/api/wechat/scan` | POST | ≤12 群 / ≤30 天 | 每群一次 `export messages` | 写临时目录后删 |
| `/api/board/ingest` | POST | items 数组 | 无 | 写云 `events`（当前链路已不用） |

链路要点（改这些地方前先看注释）：
- `/api/auth/szu` **只登一次**，教务走 `casSsoInto` 换票，重复登录会 401 风控。
- 畅课 `/api/todos` 的 `end_time` 是 **UTC**，`fetchTodos` 用 `new Date(raw).toISOString()` 归一，
  前端按本地时区渲染 —— 不要在中途再 `+08:00` 补一次。
- 作业详情链接必须是 `#/material/{id}` 的 hash 形态，`/homework/{id}` 实测 404。

---

## 三、前端：组件职责

```
Dashboard            会话查询 + 5 个 tab + 提醒角标；游客也进主界面
├ ReminderBar        读 listEvents + 本机 ddls → computeReminders；60s 轮询
├ CalendarPanel      6 路数据合并成 CalItem；月历 / 相关性过滤 / 新建删除
├ DdlPanel           本机 ddls + 云 deadline + 本机 personal → buildDeadlines
│  └ LmsSync         畅课登录 / 一键同步（仅 localhost 显示）
├ CheckinPanel       纯本机，课程+老师聚合
├ PasteImporter      4 种模式：auto / chat / ddl / event
├ ProfilePanel       画像 + 课表导入 + 微信入口
│  ├ LoginPanel      统一认证登录卡
│  └ WeChatImporter  本机扫描 / 手动粘贴
│     └ WeChatSetup  no-exe → no-data → no-key → ready 四态向导
└ SyncReceiver       浏览器插件的 postMessage 接收器（常驻，有数据才浮出）
```

数据流一句话：**每个面板自己去取自己那一层的数据，没有任何共享缓存**（这是 P1-9 的根源）。

---

## 四、问题清单

### P0 —— 现在就是错的

**P0-1 `PasteImporter` 三处 stale closure（自动解析全失效）**
`components/PasteImporter.tsx:76,186,205`

```ts
setImage(url);  setTimeout(() => parseChat(), 80);   // 76-77  parseChat 捕获旧 image=""
setText(content); setTimeout(() => parse(), 100);    // 205   parse 捕获旧 text=""
setTimeout(() => parse(), 150);                      // 192   同上
```

`setState` 是异步的，定时器里的函数是**上一次 render** 的闭包，读到的仍是旧值。
后果：点「读取剪贴板」必报「先粘贴内容再解析」；Ctrl+V 自动解析解析的是空串；
聊天截图粘贴后报「粘贴群消息文字，或直接 Ctrl+V…」。用户只能手动再点一次按钮。

改法（任一）：
```ts
const textRef = useRef(text); textRef.current = text;   // 或 useRef + useEffect 同步
// 或改成参数式：function parse(input = textRef.current)
```

**P0-2 `/api/wechat/status` 会让整个 dev server 卡死**
`lib/wechat-local.ts:134`（`spawnSync`）、`lib/wechat-local.ts:364`（`weflowStatus`）、
`app/api/wechat/status/route.ts:16`

`weflowStatus()` 同步执行：`--version`（20s）+ `db test`（60s）+ `detectWeChatDirs()`
（`readdirSync` 扫 C–H 盘根 + 一层）。`spawnSync` 阻塞 Node 唯一的主线程 ——
**这期间所有页面和接口都停住**，20s 缓存救不了首次调用。
`/api/wechat/groups` 再叠一个 90s 的 `chat contacts`，`/api/wechat/scan` 是 N×180s 串行。
打开「我的」tab 就会触发这条链。

改法：`spawnSync` → `execFile` + Promise；`weflowStatus` 改成「read 缓存 → 命中即返回，
未命中返回 `probing`，后台跑探测、前端轮询」；`detectWeChatDirs` 只在 `no-exe/no-data` 时才跑。

**P0-3 DdlPanel「全部」筛选下已截止条目重复渲染**
`components/DdlPanel.tsx:202-203`

```ts
const visible = ... filter === "all" ? all : ...      // all 里已含 expired
const expiredVisible = filter === "done" ? [] : ...   // 又收一次 expired
```
改法：`expiredVisible` 在 `filter === "all"` 时也返回 `[]`，或 `visible` 在 all 模式下剔除 `status==="pending" && 已过期`。

---

### P1 —— 数据会错 / 体验明显受损

**P1-4 每次进「我的」都会用课表里的旧画像覆盖你手改的画像**
`components/ProfilePanel.tsx:62-81`

只要 localStorage 有 timetable 且带 `profile`，就无条件 `setCollege(p.college || "")` 并
`saveProfile(merged)` 回写云端 —— 用户改过的学院/专业会被课表副本冲掉，且是自动回写。

改法：`college: p.college || college`（当前表单值）作为兜底；或者只在 `!touched.current && !college` 时 seed；
自动回写云端建议去掉，改由「保存画像」按钮触发。

**P1-5 学院 / 年级匹配是精确字符串比较，实际几乎匹配不上**
`components/CalendarPanel.tsx:266-274` + `lib/szu/portal.ts:237-277`

- `profile.college` 来自 `userInfo.userDepartment`（如「计算机与软件学院」），
  通知里写「计软学院」「计算机学院」→ `item.college === profile.college` 永不成立。
- `profile.grade` 是 `${学号前四位} 级`（带空格），通知里多为「2026级」→ 同样不成立。
- `profile.major` 恒为空：`currentUser.do` 不返回 `zymc/bjmc`，`pick()` 全部落空（这条已确认是接口限制）。

改法：比较前做归一化 `s.replace(/[\s·・]/g,"")` 并允许 `includes` 双向包含；
`grade` 统一成 `2026` 四位数字比较。这是「只看与我相关」当前最大的功能缺口。

**P1-6 公共截止的「已完成」标记会随重新入库丢失**
`lib/deadlines.ts:76`（`event:${e.id}` 作为 key）

`ingest-notices` 是 delete+insert 或新 id 时，`ddl-done:v1` 里的 `event:123` 就指向不存在的行 ——
用户勾掉的又变回待办。改法：key 用 `event:${sourceUrl || title+date}` 的稳定串。

**P1-7 `importDdls` 的去重键会在课程名变化时产生重复行**
`lib/local-store.ts:245-247`（`course + title`）

`fetchTodos` 拿不到课程名时会退化成「未匹配课程」，下次拿到真名 → 同一作业变两条。
改法：优先用 `url`（含 `course_id + material_id`）做主键，`course+title` 只作兜底。

**P1-8 「本周一」会被算到下周**
`lib/chat-extract.ts:256-265`

```ts
let delta = (target - cur + 7) % 7;              // 恒为非负 → 只会往后
if (m[1] === "下") delta = delta === 0 ? 7 : delta + 7;
```
周三看到「本周一」→ delta=5 → 下周一。改法：`本/这` 且 `target < cur` 时 `delta -= 7`。

**P1-9 同一个 events 表被拉 2–3 次，且 60s 全量轮询**
`CalendarPanel.tsx:138`、`DdlPanel.tsx:146`、`ReminderBar.tsx:68`

`ReminderBar` 常驻且每 60s `listEvents()` 一次；切 tab 时对应面板再拉一次；`select("*")` 无分页。
改法：`lib/data.ts` 加模块级缓存 + 订阅（或 SWR），`ReminderBar` 复用同一份。

**P1-10 粘贴导入的 DDL 被标成「畅课」**
`lib/deadlines.ts:70`

```ts
source: (d.source === "lms-sync" ? "lms-sync" : "manual")
```
`PasteImporter.tsx:224-231` 没传 `source` → `importDdls` 默认 `"lms-sync"` → 徽章显示「畅课」。
改法：插件传 `source: "paste-import"`，`deadlines.ts` 补一条映射，`sourceStyle` 已有该键。

---

### P2 —— 建议顺手处理

| # | 位置 | 问题 |
|---|---|---|
| P2-11 | `lib/data.ts:81-89` | `deleteEvent` 只按 id 删，无 scope/owner 谓词，全靠 RLS 兜；`createEvent` 允许任何访客写 `scope:"school"`，无审核 |
| P2-12 | 所有 `/api/lms/*`、`/api/wechat/*` | 服务端没有任何「仅本机」校验；一旦部署，别人可以 POST `/api/wechat/scan` 在服务器上跑 exe。建议加 `requireLocal(req)`（host ∈ localhost/127.0.0.1） |
| P2-13 | `app/api/wechat/config/route.ts:27-35` | GET 返回 `config`（含绝对 exePath），与 status 刻意隐藏 exePath 的口径不一致 |
| P2-14 | `lib/szu/portal.ts:364-409` | 返回类型写 `payload: TimetablePayload`（profile 必填），实际对象里没有 profile，由 route 补 —— 类型在说谎，复用者会拿到 undefined |
| P2-15 | `lib/szu/cas.ts:239-252` + `app/api/auth/szu/route.ts:56-65` | `casSsoInto` 返回 finalUrl（永远是字符串），`jwkwOk = Boolean(landed)` 基本恒真。应改成 `await jwkwAlive(jar)` |
| P2-16 | `lib/szu-lms.ts:273-279` | `loggedIn` 只看文件存在 + mtime，jar 早死了也报「已连接」（页面会显示已连接但同步 401）。建议记 lastOkAt 或状态接口带一次轻探测 |
| P2-17 | `lib/llm.ts:7-20` vs `:157` | `ParsedEvent.kind` 不含 `"deadline"`，但解析和白名单都允许；`PasteImporter` 的下拉也有它。类型该放宽 |
| P2-18 | `components/CalendarPanel.tsx:90,106` | `szu-cal-hidden` 不符合 `szu-calendar:*:v1` 命名，无版本号，后续迁移会疼 |
| P2-19 | `components/CalendarPanel.tsx:211` | `e.scope === "personal"` 是死分支（`listEvents` 已过滤掉 personal），留着容易误导 |
| P2-20 | `components/LmsSync.tsx:138,139` | `setBusy(false)` 后立刻 `await sync()`（sync 内部又 setBusy(true)），按钮会闪一下 |

---

## 五、建议的修复顺序

1. **P0-1**（10 分钟，改 3 处闭包）—— 用户能立刻感觉到「粘贴导入好用了」。
2. **P0-3**（3 行）—— 顺手。
3. **P0-2**（半天）—— 先把 `weflowStatus` 改成缓存 + 后台探测，其余不动；否则每次调微信相关功能都会怀疑「是不是卡了」。
4. **P1-5 + P1-4**（半天）—— 这两条决定「只看与我相关」到底有没有用。
5. **P1-9 + P1-6 + P1-7**（一天）—— 数据一致性，越晚改历史数据越脏。
6. 其余 P1/P2 按需。

---

## 六、改代码时的三条硬约束

1. **不要在服务端给 `dueAt` 再加时区**。畅课给 UTC，`fetchTodos` 已归一；`chat-extract` 给 `+08:00`；
   课表给无时区本地串。三处口径不同是**故意的**，各自注释里写了原因。
2. **`data/` 下全是本机会话**（`.web-session-key` / `.ehall-session.json` / `.lms-session.json`），
   `.gitignore` 已兜住，`git ls-files data` 只有两份公开通知快照。新增任何本机文件都要落在 `data/`。
3. **别 `git rebase`**（这台机器会把 `.git` 移进回收站）。要线性历史用 `cherry-pick`，
   要同步远端用 `git merge --ff-only` 或 `reset --hard FETCH_HEAD`。
