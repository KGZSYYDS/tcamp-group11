# tcamp-group11 · 深大日历

> **接手先读 [`docs/HANDOVER.md`](docs/HANDOVER.md)** —— 里面写清了该用哪个分支、代码地图、
> 数据模型、已修与未修的问题、排障手册。本文件只讲启动与命令。

面向深大同学的校园日历：作业 DDL、签到、考试、体测、活动集中在一张月历里。基于 `szu-calendar-demo` 二次开发。

技术栈：Next.js 14（App Router）+ TypeScript + Tailwind CSS；数据走 WorkBuddy 云服务（PostgreSQL / OTP 登录 / 免密钥 LLM）。

## 启动

**先确认分支是 `hwb`**（`git branch --show-current`）。`main` 是旧架构，缺十项修复，见 [`docs/branch-divergence.md`](docs/branch-divergence.md)。

首次运行会自动安装依赖，装完直接开 http://localhost:3000。

Windows：双击 `start.bat`

macOS / Linux：

```bash
chmod +x start.sh && ./start.sh
```

手动方式：

```bash
npm install
npm run dev
```

> 需要 Node.js 18+。首次安装约 2–5 分钟（依赖体积较大）。

### 自检登录与畅课

服务起来后另开一个终端：

```bash
node scripts/selfcheck.mjs
```

学号密码可交互输入（密码不回显），也可以用环境变量：

```bash
SZU_USER=2024xxxx SZU_PASS=*** node scripts/selfcheck.mjs
```

脚本只连 `localhost`，密码不会发到外部。它依次验证
**服务 → 统一认证 → 会话 → 档案 → 课表 → 畅课登录 → 畅课作业**，
断在哪一步会直接说明原因和下一步该做什么。

## 目录

```
app/            页面与服务端接口（App Router）
components/     日历 / DDL / 签到 / 粘贴导入 / 微信导入 / 登录 / 画像面板
  calendar/     月周视图、时间轴、事件弹窗、动效补件
lib/            云 SDK、数据访问层、视图模型（agenda / useAgenda）、可见性、解析、采集
  pipeline/     归一化 → 抽取 → 去重 → 落地（尚未接界面）
  ingest/       采集器适配器契约（尚未接界面）
extension/      浏览器插件（Manifest V3，Chrome / Edge）
public/         插件 zip 下载入口
scripts/        采集器与测试（公文通 / 官网 / 课表 / 微信 / 日期回填）
examples/       **真实数据样例**，对接方从这里看格式
docs/schema/    JSON Schema（draft 2020-12）
docs/           交接文档、分支说明、修复记录、数据来源与契约
start.bat|sh    一键启动（缺依赖时自动 npm install）
```

## 数据格式（对接先看这里）

不写长文档，直接给真跑出来的数据：

- [`examples/README.md`](examples/README.md) —— **25 份真实 JSON**：7 类实体、4 个文件、10 个接口的请求/响应，全是实抓
- [`docs/schema/`](docs/schema/) —— **12 份 JSON Schema**（draft 2020-12），同名 `.schema.json` 可直接校验

```bash
pip install jsonschema
python scripts/validate-contract.py    # 退出码 0 = 全部通过
```

校验会拿**全量真数据**跑一遍：`data/board/notices-latest.json`（556 条）与
`data/web/notices-web-latest.json`（40 条）逐条对 `notice.schema.json`。

## 浏览器插件

插件是**备用通道**。现在网页里已经能直接完成主要的两件事，不装插件也能用：

| 需求 | 网页内做法 | 入口 |
|---|---|---|
| 畅课作业截止 | 输一次统一认证账号，服务端直连 `/api/todos` 拉回来 | 「DDL」页 · 畅课作业 |
| 班群里的会议/截止 | 本机一键扫描微信记录（要装 WeFlow），或粘贴文字 | 「我的」页 · 导入微信 |
| 课表 | 登录后自动带回，或导入 `data/timetable/*.json` | 「我的」页 |

插件用法（想抓畅课全站待办时）：

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录
3. 登录畅课 / 内部网后，点插件图标同步作业与通知
   （也可用网页里的「+ 粘贴导入」，不装插件）

## 数据采集

采集器走统一身份认证（CAS）。**密码不落盘**：只在建会话那一次用，之后复用 Cookie 缓存；密码可交互输入或用环境变量传入。

```bash
SZU_USER=学号 SZU_PASS='密码' npm run collect:profile   # 姓名/学院/专业/年级 → data/profile.json
npm run collect:board                    # 公文通 → data/board/*.json
npm run collect:web                      # 官网 3 频道（免登录）→ data/web/*.json
npm run ingest:notices                   # 公文通结果 → 云数据库（scope=school，按 URL 去重）
npm run ingest:notices -- --source web   # 官网结果 → 云数据库（source=web）
npm run backfill:dates                   # 用采集文件重算已入库的 start_at（默认只算不写，加 --apply 才改库）
npm run collect:timetable                # 办事大厅「我的课表」→ data/timetable/*.json（本机文件）
npm run meetings:all                     # 微信全量群 → data/meetings/*.json（本机文件）
```

- 公文通全站要登录，没有公开 API；采集器登录一次拿 Cookie，之后按栏目翻页。
- 公文通主题分类在入库后运行。配置服务端环境变量 `BOARD_AI_ENABLED=1`、`BOARD_AI_BASE_URL` 和 `BOARD_AI_API_KEY` 后，公文通入库脚本会启动后台分类进程，默认模型为 `deepseek-flash`。也可用 `npm run classify:board` 单独补跑，或用 `npm run classify:board -- --dry-run` 查看筛选范围。队列只处理上海时间最近两个月发布、已入库且尚无分类的公文通通知，失败时保留原通知，后续任务可重试。日历与时间轴不会调用模型。模型地址默认要求 HTTPS；`BOARD_AI_ALLOW_HTTP=1` 仅用于受控测试。
- 课表按「课程 + 周次 + 星期 + 节次」展开成单次上课事件；
  周次锚点取自教务系统（`jwkw` 的 `classWeek.do`），节次时间表在 `scripts/collect-timetable.mjs` 顶部。
- **课表和群聊待办不进云库**：它们写成 `data/` 下的本机 JSON，到网页「我的」页导入，存进浏览器 localStorage。
  谁的浏览器里有这个文件，就是谁的数据 —— 不需要学号哈希、不需要认领，也就没有抢占问题。
  文件里带着姓名/学院/专业/年级，导入时自动填进画像，不用手打。
- 微信采集先用正则筛「带时间表达」的消息，再交模型归一化；默认扫全部群（227 个），不靠群名白名单猜。
- 各系统能拿到什么、需要用户给到什么权限，见 [`docs/data-access.md`](docs/data-access.md)。

## 协作约定

- 依赖、构建产物、本地个人数据（`node_modules/`、`.next/`、`data/`）不入库，克隆后按上面方式启动即可。
  `data/` 只有两个例外入库：`data/board/notices-latest.json`、`data/web/notices-web-latest.json`
  —— 内容全是公开发布的通知、不含个人信息，是 `backfill:dates` 的默认输入，也是对接方唯一能看到全量真实结构的地方
  （`.gitignore` 里要先放行目录再放行单个文件，否则 git 不会往下看）
- 改动走功能分支，合并前提 PR 到 `main`
- 云服务实例配置在 `lib/cloud.ts`（`publishableKey` 是前端公开配置，非密钥）
