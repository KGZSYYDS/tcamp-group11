# 交接文档 · 深大日历（tcamp-group11）

> 给接手的同学：看完这份，应该能自己把项目跑起来、知道每块代码在哪、哪些地方是雷。
> 最后更新：2026-11-10 · 对应分支 `hwb` @ `1d698f4`

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 是什么 | 深大校园日历：把作业 DDL、签到、考试、体测、讲座活动收进一张月历 |
| 技术栈 | Next.js 14（App Router）+ TypeScript + Tailwind；`motion` 做动效；云端是 WorkBuddy Cloud（PostgreSQL） |
| 当前主线 | **`hwb`**（新架构，23 个提交） |
| 云库数据 | `events` 636 行公共事件 + `profiles` 画像；个人数据全在浏览器 localStorage |
| 能不能跑 | 能。`npm install` → `npm run dev` → `localhost:3000` |
| 最要紧的一句 | **`main` 是旧架构、缺十项修复，别在它上面接着写**（详见 `docs/branch-divergence.md`） |

---

## 1. 上手

### 1.1 环境

- Node.js **18+**（本机实测 22 可用）
- 无需数据库账号：云端用 `lib/cloud.ts` 里的 publishable key（前端公开配置，不是密钥）

### 1.2 三步启动

```bash
git checkout hwb          # 先确认分支！这是最容易错的一步
npm install               # 必须装，见下方「三个新依赖」
npm run dev               # http://localhost:3000
```

**三个容易漏的依赖**：`hwb` 新增了 `motion`、`lucide-react`、`@fontsource-variable/manrope`。
没装的话 dev 直接 `Module not found` 编译失败，页面白屏 —— 表现非常像「云端挂了 / 拉不到数据」，
但其实是本地依赖缺失。

### 1.3 页面访问不了时的排查顺序

```bash
git branch --show-current     # ① 是 hwb 吗？
npm install                   # ② 三个新依赖装了吗？
rm -rf .next && npm run dev   # ③ 旧产物缓存了已删除的路由
```

再看浏览器控制台：`Failed to fetch` / CORS 才是网络问题。

### 1.4 自检脚本

```bash
node scripts/selfcheck.mjs    # 依次验：服务 → 统一认证 → 会话 → 档案 → 课表 → 畅课登录 → 畅课作业
npm test                      # 截止解析 / 时间解析 / 提醒计算 三组回归
```

`selfcheck` 只连 `localhost`，密码不发外部；学号密码可交互输入或用 `SZU_USER` / `SZU_PASS`。

---

## 2. 分支：只有 `hwb` 该继续动

```
e0278e0  ← 两条线的分叉点
   ├── main   ：b5d9f38 相关性打分+按月加载 → dbca741 → 783034f(PR#5)   旧架构，3 个提交
   └── hwb    ：2f66c3d → 1c1f30a → 88d32e5(十项修复) → be16288 → 1d698f4   新架构，23 个提交
```

| | `main` | `hwb` |
|---|---|---|
| 组件架构 | 逻辑堆在 `CalendarPanel.tsx` | 拆到 `components/calendar/*` + `lib/agenda.ts` |
| 有 `lib/visibility.ts` | ✗ | ✓ |
| 有 `lib/useAgenda.ts` | ✗ | ✓ |
| 十项 P0/P1 修复 | ✗ | ✓ |
| 相关性打分 / 按月加载 | ✓（唯一优势） | ✗ |

**结论**：主线用 `hwb`。`main` 上只有「相关性打分 + 按月加载」值得拿过来，
移植的成本主要在日历组件那一层重接。要不要做、什么时候做，先跟组里定。

`main` 上还有个**能卡死整个服务**的坑：`app/api/wechat/status` 用 `spawnSync` 扫盘，
一进「导入」页就触发，会阻塞 Node 事件循环，期间所有请求（含云端 `events`）全部排队。
`hwb` 已改异步。

> 详细证据（逐行行号、文件差异、三种合并方案代价）见 **`docs/branch-divergence.md`**。

---

## 3. 代码地图

```
app/
  page.tsx                    唯一页面，渲染 <Dashboard/>
  layout.tsx                  字体、全局样式、元信息
  api/                        12 个服务端路由（见 §3.3）
  styles/calendar.css         日历专属样式
  styles/workspace.css        工作区 / 底部 Dock 样式

components/
  Dashboard.tsx               外壳：5 个 Tab 的切换、登录态、提醒条
  CalendarPanel.tsx           日历面板（月/周/时间轴三种视图）
  DdlPanel.tsx                截止日期面板（按来源筛、已截止分组）
  CheckinPanel.tsx            签到面板（记录签到 → 统计）
  PasteImporter.tsx           粘贴导入（文字 / 剪贴板图片 / 文件）
  WeChatImporter.tsx          微信导入（一键扫描 / 粘贴 / 选文件三条通道）
  WeChatSetup.tsx             陌生电脑引导（找工具 → 认目录 → 等密钥）
  ProfilePanel.tsx            「我的」：画像、课表、登录
  LmsSync.tsx                 畅课作业同步（登录 + 一键拉取）
  ReminderBar.tsx             顶部提醒条（页面内，非系统推送）
  SyncReceiver.tsx            导入文件接收
  calendar/                   新架构的日历视图层
    MonthWeekView.tsx         月/周网格
    TimelineView.tsx          时间轴
    ClockFace.tsx             表盘式时间显示
    EventDialog.tsx           新建/编辑事件弹窗
    ui/                       动效补件：Dock / SpotlightCard / TextMorph / SlidingNumber …

lib/
  ── 数据访问 ──────────────────────────────
  data.ts                     云库唯一入口：events / profiles + 5 分钟缓存
  local-store.ts              本机唯一入口：课表 / 作业 / 签到 / 自建事件
  cloud.ts                    SDK 实例与 publishable key
  ── 视图模型 ──────────────────────────────
  agenda.ts                   CalEvent/Ddl/Checkin/课表 → AgendaEvent（纯函数）
  useAgenda.ts                把五种数据源合成一份列表 + 增删分发
  visibility.ts               可见性判断唯一入口（isVisible）
  ── 业务规则 ──────────────────────────────
  deadlines.ts                截止视图：云事件 + 本机作业 + 本机群聊 → 一份 DDL
  reminders.mjs               提醒窗口计算（纯函数，有测试）
  parse-time.mjs / time-hints.mjs / deadline.mjs   时间与截止解析（纯函数）
  chat-extract.ts             群聊文本 → 事项（纯正则，不调模型）
  wechat-paste.ts             5 种微信粘贴格式归一
  wechat-local.ts             微信本机链路（找工具 / 找库 / 导出 / 扫描）
  szu-lms.ts                  畅课三跳登录 + 待办
  szu/                        CAS 登录、办事大厅、会话签发
  ── 尚未接界面 ────────────────────────────
  pipeline/                   归一化 → 抽取 → 去重 → 落地（同事写的，未接 UI）
  ingest/                     采集器适配器契约（同上）
  sink/jsonl-sink.ts          写 data/drafts/*.jsonl（依赖 node:fs，别在浏览器码里 import）
```

### 3.1 主链路一：看日历

```
云库 events ──listEvents()──┐
本机 timetable ─────────────┤
本机 ddls / checkins ───────┼──► buildAgenda() ──► AgendaEvent[] ──► MonthWeekView / TimelineView
本机 my-events ─────────────┘        (lib/agenda.ts)      (lib/useAgenda.ts)
```

`useAgenda` 是唯一的数据入口。组件不要自己去 `listEvents()`，否则缓存和刷新会不同步。

### 3.2 主链路二：截止日期

```
云事件里的 kind=deadline 行 ┐
本机 ddls（畅课 + 粘贴）    ├──► buildDeadlines() ──► DdlPanel
本机群聊排出的事项          ┘     (lib/deadlines.ts)
```

去重键：云事件用「标题 + 日期 + 学院」，本机作业用「课程 + 标题」或 url。

### 3.3 服务端路由（12 个）

| 路由 | 作用 | 备注 |
|---|---|---|
| `POST /api/auth/szu` | 统一认证登录，返回档案 + 课表 | 密码只在内存用一次 |
| `GET /api/auth/session` | 读当前会话 | HMAC 签名 cookie，7 天 |
| `POST /api/szu/timetable` | 重新同步课表 | |
| `POST /api/lms/login` | 畅课三跳登录 | 失败返回 401 + `showErrorTip`，不是 200 |
| `GET /api/lms/status` | 畅课是否已登录 | |
| `GET /api/lms/ddls` | 畅课待办 | |
| `GET /api/wechat/status` | 微信通道状态 | **异步 + 缓存，别改回同步** |
| `GET /api/wechat/config` | 扫 WeFlow / 微信目录候选 | |
| `POST /api/wechat/config` | 保存工具路径 / 验证并写入库目录 | 写前必须 `db scan` 验证 |
| `POST /api/wechat/key` | 后台等密钥 | 输出含密钥 → `stdio: ignore` |
| `GET /api/wechat/groups` | 群列表，按「像不像通知群」打分 | |
| `POST /api/wechat/scan` | 导出选中群 → 规则抽取 | 临时文件 `finally` 里删 |

---

## 4. 数据模型

### 4.1 三层，别搞混

| 层 | 存在哪 | 有什么 | 谁能读 |
|---|---|---|---|
| **公共** | 云库 `events` | 公文通通知、官网公告、讲座、报名截止（`scope=school`） | 所有人，含未登录 |
| **公共** | 云库 `events` | 院级/年级公告（`scope=college/grade`） | 登录用户 |
| **个人** | 浏览器 localStorage | 课表、作业、签到、自建事件、群聊排出的事项、已完成勾选 | 只有这台设备 |
| **个人** | `data/` 本机文件 | 采集中间产物、微信原始导出、会话缓存 | 只有本机（已 gitignore） |

**三条硬规则**（违反任何一条都是数据事故）：

1. **个人数据不进 `events` 表**。那张表对匿名 key 全表可读，塞进去等于公开。
2. **密码永不落盘**。登录只在内存换一次 ticket，之后靠 30 天 cookie 缓存。
3. **判可见性只调 `isVisible()`**，别在组件里自己写 `if (scope === 'college')`。

### 4.2 localStorage 键

| 键 | 内容 |
|---|---|
| `szu-calendar:timetable:v1` | 课表（按学期覆盖） |
| `szu-calendar:ddls:v1` | 作业截止 |
| `szu-calendar:checkins:v1` | 签到记录 |
| `szu-calendar:my-events:v1` | 自建「仅自己」事件 |
| `szu-calendar:ddl-done:v1` | 对公共截止的「已完成」勾选 |
| `szu-calendar:personal:v1` | 群聊排出的会议/截止 |
| `szu-calendar:reminder-dismissed:v1` | 关掉的提醒（key@dueAt） |

### 4.3 可见性

`lib/visibility.ts` 是唯一入口。几个已经踩过的坑，改之前先读代码注释：

- **不是精确字符串比较**。「计软」要能匹配「计算机与软件学院」——用的是去前缀、
  去「学院/学部/系」后缀 + 双向子序列匹配。
- **年级比的是 4 位数字**，不是整串文本。
- **判不准就往窄里落**，不会自动升级成 `public`。

---

## 5. 已经修好的（别重复踩）

基于 `hwb @ 1c1f30a` 修的十项，提交 `88d32e5`：

| 编号 | 原来的问题 | 修法 |
|---|---|---|
| P0-1 | 粘贴导入自动解析全部失效 | `setTimeout` 读到旧闭包 → 用 ref 镜像 + 显式入参 |
| P0-2 | `/api/wechat/status` 冻结整个 dev server | `spawnSync` → `execFile` 异步 + `globalThis` 缓存 + 过期探测 |
| P0-3 | 作业「全部」里已截止条目重复渲染 | `expiredVisible` 条件写错，只在 `pending` 时显示 |
| P1-4 | 进「我的」用课表副本覆盖手改画像 | 去掉无条件 `saveProfile`，改用「保存画像」按钮 |
| P1-5 | 学院/年级几乎匹配不上 | 归一化 + 子序列匹配（13/13 断言） |
| P1-6 | 公共截止的「已完成」随重新入库丢失 | 去重键改「标题+日期+学院」，不再用行 id |
| P1-7 | 畅课课程名退化让同一作业变两条 | 优先按 url 查重，课程名变化时更新而非新增 |
| P1-8 | 「本周一」在周三算成下周一 | 周偏移以周一为锚，允许负数 |
| P1-9 | `events` 被拉 2–3 次 + 60s 全量轮询 | 5 分钟共享缓存 + 在途复用 + 写后失效 |
| P1-10 | 粘贴导入的作业被标成「畅课」 | 透传 `source: "paste-import"` |

验证结果：`tsc` 0 错；冷启动 36ms（修复前阻塞数十秒）；切 3 个 Tab `/events` 只 1 次请求；
作业「全部」39 条无重复（修复前 56）。细节见 **`docs/fix-log.md`**。

---

## 6. 还没做的

按建议优先级排：

1. **`lib/pipeline` + `lib/ingest` 还没接界面**。
   同事写的数据管道（归一化→抽取→去重→落地）是完整的，但 `components/` 里没有任何引用。
   要接的话从 `runPipeline()` 开始看，契约在 `docs/data-layer.md`。
2. **相关性打分 / 按月加载只在 `main` 上**（`lib/relevance.mjs`）。
   636 条全量下拉 + 前端排序，事件多了会卡。要移植到 `hwb` 的日历组件。
3. **提醒只在页面内**（`ReminderBar` 每 60s 算一次），没有系统推送。
   要做推送需要 Web Push 或企业微信应用消息，且得常驻调度。
4. **企业微信拿不到历史聊天**。官方 API 不给，也没有等价导出工具，
   只能靠复制/截图 —— 这是产品边界，不是没做完。
5. **采集要手动跑**，没有定时任务（`npm run collect:board` 等）。
6. **P2 批次未处理**：`requireLocal` 入参校验、`deleteEvent` 权限谓词、
   `szu-cal-hidden` 命名不一致等。
7. **`docs/schema/` 与实际数据可能已漂移**：schema 是 2026-11-08 的，
   之后 `events` 加了 `scope` 过滤、`personal` 行被清零，校验脚本值得重跑一遍。

---

## 7. 排障手册

| 症状 | 先查什么 | 处理 |
|---|---|---|
| 页面白屏 / 一直「加载中…」 | 分支是不是 `main`？三个新依赖装了吗？ | 切 `hwb` + `npm install` + 删 `.next` |
| 云端一条数据都没有 | 浏览器 Network 里 `/events` 的响应 | 见 §7.1 |
| dev server 整体卡住几十秒 | 有没有进过「导入」页 | 那是 P0-2，`hwb` 已修；`main` 上仍会卡 |
| 微信显示「没找到工具」 | WeFlow 装没装 | 手填 `weflow.exe` 路径，或点「自动检测」 |
| 微信显示「密钥过期」 | 微信是否重登过 | 起后台任务等重登，最长 10 分钟 |
| 「本周一」算错 | 今天周几 | P1-8 已修；若在 `main` 上就是没修 |
| 学院过滤筛不出东西 | 画像里的学院名 | P1-5 已做近似匹配；仍不行看 `sameAffiliation` |

### 7.1 「云端拉不到」的正确诊断姿势

**别用 curl 判断。** 新版界面是纯客户端渲染，首屏 HTML 固定是「加载中…」，
`curl http://localhost:3000/` 只能拿到 5.6KB 空壳，看起来就像没数据。

正确做法：

1. 浏览器打开页面，等 2–3 秒，看是否真的渲染出事件标题；
2. 打开 DevTools → Network，筛 `events`，看状态码与响应体；
3. 如果请求 403：检查鉴权头。SDK 只认 **`x-wb-webapp-access-key`**，
   写成 `apikey` 会稳定 403 —— 这个很容易被当成「云端挂了」。

云库健康时的参考值：`events` 636 行，Node 直查约 0.9s，浏览器 fetch 约 850ms。

---

## 8. 改动前必须知道的五条

1. **别在 `main` 上加功能**。两边分歧只会越来越大。
2. **别把 `lib/wechat/status` 改回同步**。`spawnSync` 会占住 Node 单线程，全站跟着卡。
3. **别在浏览器代码里 import `lib/sink/`**。它依赖 `node:fs`，打包会炸。
4. **别在前端自己写可见性判断**。统一走 `isVisible()`，判不准它会藏起内容，而不是漏出去。
5. **别给 `dueAt` 随手加时区**。畅课是 UTC、群聊是 +08:00、课表是本地串，
   三处口径不同是**故意的**，改一处会连带错三处。

---

## 9. 文档索引

| 文档 | 讲什么 | 什么时候看 |
|---|---|---|
| `docs/HANDOVER.md` | **本文**，总入口 | 第一天 |
| `docs/branch-divergence.md` | `hwb` vs `main` 的差异与合并方案 | 决定主线 / 合并前 |
| `docs/fix-log.md` | 十项修复的根因、改法、验证 | 改到相关文件时 |
| `docs/code-review.md` | 原始审计（基于 `e0278e0`） | 想知道问题最初怎么发现的 |
| `docs/data-access.md` | 每个数据源要什么权限、实测状态、踩坑史 | 接新数据源 / 采集报错 |
| `docs/data-layer.md` | 采集/处理/展示三层契约 | 接 `pipeline` 时 |
| `README.md` | 启动与常用命令 | 第一次跑起来 |
| `examples/` | 25 份真实 JSON 样例 | 对接格式 |

---

## 10. 交接清单

接手当天勾一遍：

- [ ] `git checkout hwb`，`git log --oneline -5` 看到 `88d32e5`（十项修复那个提交）
- [ ] `npm install` 无报错，`npm run dev` 起来
- [ ] 浏览器打开首页，2–3 秒内看到 11 月日历铺满事件（不是「加载中…」）
- [ ] `npx tsc --noEmit` 0 错
- [ ] `npm test` 三组回归全过
- [ ] 切「日历 → 作业 → 签到」各看一眼，Network 里 `/events` 只有 1 次
- [ ] 读一遍 `docs/branch-divergence.md`，跟组里确认主线就是 `hwb`
- [ ] 确认谁负责「把 relevance 移植进 hwb」这件事，别悬着
