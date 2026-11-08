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

## 协作约定

- 依赖、构建产物、本地数据（`node_modules/`、`.next/`、`data/`）不入库，克隆后按上面方式启动即可
- 改动走功能分支，合并前提 PR 到 `main`
- 云服务实例配置在 `lib/cloud.ts`（`publishableKey` 是前端公开配置，非密钥）
