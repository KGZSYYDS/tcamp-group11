# tcamp-group11 · 深大日历

面向深大同学的校园日历：作业 DDL、签到、考试、体测、活动集中在一张月历里。基于 `szu-calendar-demo` 二次开发。

技术栈：Next.js 14（App Router）+ TypeScript + Tailwind CSS；数据走 WorkBuddy 云服务（PostgreSQL / OTP 登录 / 免密钥 LLM）。

## 启动

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

## 目录

```
app/            页面 + 本地 API routes（采集器备用入口）
components/     日历 / DDL / 签到 / 粘贴导入 / 登录 / 画像面板
lib/            云 SDK、数据访问层（RLS 去重导入）、AI 解析、类型定义
extension/      浏览器插件（Manifest V3，Chrome / Edge）
public/         插件 zip 下载入口
start.bat|sh    一键启动（缺依赖时自动 npm install）
```

## 浏览器插件

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录
3. 登录畅课 / 内部网后，点插件图标同步作业与通知
   （也可用网页里的「AI 粘贴导入」，不装插件）

## 数据采集

两个采集器都走统一身份认证（CAS）。账号密码只存本地 `data/.credentials.json`（已被 gitignore），不进仓库：

```bash
npm run auth:save -- 482848 "你的密码"   # 只跑一次
npm run collect:board                    # 公文通 → data/board/*.json
npm run ingest:notices                   # 上一步结果 → 云数据库（scope=school，按 URL 去重）
npm run collect:timetable                # 办事大厅「我的课表」→ 云数据库（scope=personal）
```

- 公文通全站要登录，没有公开 API；采集器登录一次拿 Cookie，之后按栏目翻页。
- 课表按「课程 + 周次 + 星期 + 节次」展开成单次上课事件，重复跑只补新增；
  周次锚点取自教务系统（`jwkw` 的 `classWeek.do`），节次时间表在 `scripts/collect-timetable.mjs` 顶部。
- 课表是个人数据：采完要去网页「我的」页填一次学号认领，课表才会归属到你账号并只对你可见
  （库里存的是学号哈希，明文不落库）。不收成绩、不收全校课表，理由见 `docs/data-access.md` §1.1。
- 各系统能拿到什么、需要用户给到什么权限，见 [`docs/data-access.md`](docs/data-access.md)。

## 协作约定

- 依赖、构建产物、本地数据（`node_modules/`、`.next/`、`data/`）不入库，克隆后按上面方式启动即可
- 改动走功能分支，合并前提 PR 到 `main`
- 云服务实例配置在 `lib/cloud.ts`（`publishableKey` 是前端公开配置，非密钥）
