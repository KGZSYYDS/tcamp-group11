# 分支现状：`hwb` 与 `main` 已经分成两条线

> 用途：和同事对齐「谁的代码是主线、修复落在哪」时直接看这份。
> 所有结论都在本地 `git fetch` 后实测，证据带提交号 / 文件行号。

---

## 一句话结论

我修的是 **`hwb` 的最新提交 `1c1f30a`**，不是旧代码；十项修复已提交并推到 `origin/hwb`（当前 `ba03ef7`）。

但 **`main` 上没有这些修复**。`main` 是另一条**旧架构**线，同事 3 小时前的 PR #5（`zhj/relevance`）只合进了 `main`。

---

## 一、我基于哪份代码修的

| 项 | 值 |
|---|---|
| 基线 | `hwb` @ **`1c1f30a`**（同事最后一次改 hwb：放大底部视图切换栏） |
| 修复提交 | **`88d32e5`** — 15 文件，+942 / −135 |
| 合并同事改动 | **`be16288`** — 把 `1c1f30a` 并进来，**无冲突** |
| 文档补充 | **`ba03ef7`** |
| 远端状态 | `origin/hwb` = `ba03ef7`，与本地 `git rev-list --left-right --count` = **0 / 0** |

结论：**是基于 hwb 的最新提交**。但**不是**基于 `main` 的 `783034f`。

---

## 二、`hwb` 修复状态：已修好、已验证、已推送

| 编号 | 问题 | 修复位置 | 验证 |
|---|---|---|---|
| P0-1 | 粘贴导入自动解析全部失效（`setTimeout` 读到旧闭包） | `PasteImporter.tsx` 用 ref 镜像 + 显式入参 | 粘贴文本 / Ctrl+V 图片均能自动解析 |
| P0-2 | `/api/wechat/status` 用 `spawnSync` 冻结整个 dev server | `wechat-local.ts` 改 `execFile` 异步 + `globalThis` 缓存 + 过期探测 | 冷启动 **36ms** 返回（修复前阻塞数十秒），命中缓存 11ms |
| P0-3 | 作业面板「全部」里已截止条目重复渲染 | `DdlPanel.tsx` `expiredVisible` 条件改 `filter === "pending"` | 「全部」39 条 = 22 待完成 + 17 已截止，无重复（修复前 56） |
| P1-4 | 进「我的」用课表副本覆盖手改画像 | `ProfilePanel.tsx` 去掉自动 `saveProfile` | 手改后刷新不被覆盖 |
| P1-5 | 学院 / 年级精确比较，实际几乎匹配不上 | `lib/visibility.ts` + `useAgenda.ts` 归一化 + 子序列匹配 | 13/13 断言通过（如「计软」↔「计算机与软件」） |
| P1-6 | 公共截止的「已完成」标记随重新入库丢失 | `deadlines.ts` key 改 `标题+日期+学院` | 重新 ingest 后勾选状态保留 |
| P1-7 | 畅课课程名退化会让同一作业变两条 | `local-store.ts` 优先按 url 查重 | 同名不同 url 不再合并、同 url 改名不新增 |
| P1-8 | 「本周一」在周三被算成下周一 | `chat-extract.ts` 周一锚定、允许负偏移 | 3/3 断言通过（本周一→11-09、下周一→11-16、周五→11-13） |
| P1-9 | `events` 表被拉 2–3 次 + 60s 全量轮询 | `data.ts` 5 分钟共享缓存 + 在途复用 + 写后失效 | 切「日历→作业→签到」5 次，`/events` 始终 **1** 次 |
| P1-10 | 粘贴导入的作业被标成「畅课」 | `PasteImporter` 传 `source: "paste-import"` | 徽章显示「粘贴」 |

其他检查：`tsc --noEmit` **0 error**；浏览器实测 11 月日历正常铺出云端事件，控制台无报错。

---

## 三、两条线怎么分叉的

```
                    e0278e0  ← 分叉点（我最初审计的基线）
                   /        \
        (main, 旧架构)      (hwb, 新架构)
              |                  |
   b5d9f38 relevance     2f66c3d 日程布局
   dbca741 docs          1c1f30a 视图切换栏
   783034f PR #5                |
        |                 88d32e5 十项修复
        |                 be16288 merge
        |                 ba03ef7 docs
```

| | `main` | `hwb` |
|---|---|---|
| 独有提交数 | **3** | **23** |
| 架构 | 旧（逻辑散在 `CalendarPanel.tsx` 等组件里） | 新（`agenda.ts` / `useAgenda.ts` / `visibility.ts` / `pipeline` / `ingest`） |
| 独有文件 | `lib/relevance.mjs`、`lib/relevance.d.mts`、`scripts/test-relevance.mjs` | **56 个**：`components/calendar/*`、`lib/agenda.ts`、`lib/ingest/*`、`lib/pipeline/*`、`docs/*` 等 |
| 有 `lib/visibility.ts` | ✗ | ✓ |
| 有 `lib/useAgenda.ts` | ✗ | ✓ |
| 有 `lib/relevance.mjs`（按月加载） | ✓ | ✗ |
| 十项修复 | ✗ | ✓ |

---

## 四、`main` 上这些 bug 一个都没修（实测）

| 编号 | `main` 上的代码 | 判断 |
|---|---|---|
| P0-1 | `PasteImporter.tsx:76/187/205` `setTimeout(() => parseChat(), 80)`；`380` 行 `onClick={parse}` | 仍在 |
| P0-2 | `lib/wechat-local.ts:19` `import { spawn, spawnSync }`；`135` 行 `spawnSync(exe, args, …)`；`app/api/wechat/status/route.ts` 直接 `weflowStatus()` | 仍在 |
| P0-3 | `components/DdlPanel.tsx:210` `const expiredVisible = filter === "done" ? [] : byTag(bySource(expired));` | 仍在 |
| P1-4 | `components/ProfilePanel.tsx:79` `saveProfile(merged).catch(() => {})` 无条件写回 | 仍在 |
| P1-5 | `main` 压根没有 `lib/visibility.ts`，匹配逻辑散在 `CalendarPanel.tsx` | 旧逻辑 |
| P1-6 | `lib/deadlines.ts:77` `const key = \`event:${e.id}\`;` | 仍在 |
| P1-7 | `lib/local-store.ts:245` 只按 `course + title` 查重，url 不参与 | 仍在 |
| P1-8 | `lib/chat-extract.ts` `delta = (target - cur + 7) % 7`（周三说「本周一」→ 下周一） | 仍在 |
| P1-9 | `main` 无共享缓存（`data.ts` 只在 `b5d9f38` 加了按月加载） | 无缓存 |
| P1-10 | `main` 的 `PasteImporter.tsx:263` 已有 `source: "paste-import"` | 已修（这条同事自己补了） |

---

## 五、这解释了一件重要的事：同事为什么「拉不到云端数据库」

`main` 上 P0-2 还在：`/api/wechat/status` 走 `spawnSync`，**同步阻塞 Node 主线程**。

触发路径很明确：

- `components/WeChatImporter.tsx:159` `useEffect(() => { void checkStatus(); })` —— **一进「导入」页就自动调**；
- → `app/api/wechat/status/route.ts` 直接 `return NextResponse.json(weflowStatus())`；
- → `lib/wechat-local.ts:135` `spawnSync(exe, args, …)`，还有 `194` 行 `spawnSync("reg", …)`
  扫盘找微信安装目录。

同步调用会把 Node 的事件循环整个占住。这段时间**所有请求都排队**，包括云端 `events` ——
前端表现就是「一直加载中 / 拉不到数据」。只要他先进过「导入」页，再回日历就会撞上。

所以同事的问题大概率不是网络、不是 RLS、也不是没装依赖，而是**他跑的是 `main`，踩了 P0-2**。
这条在 `hwb` 上已经修掉（`execFile` 异步 + `globalThis` 缓存 + 过期探测，冷启动 36ms 返回）。

> 顺带两个容易误判的坑：
> 1. 新版界面是**纯客户端渲染**，首屏 HTML 固定是「加载中…」，`curl` 只能拿到空壳，必须用浏览器等 2–3 秒。
> 2. SDK 鉴权头是 `x-wb-webapp-access-key`，写成 `apikey` 会稳定 403。

---

## 六、可选的三条路

| 方案 | 做法 | 代价 | 适合 |
|---|---|---|---|
| **A. 把 relevance 移植进 `hwb`**（推荐） | 拷 `lib/relevance.mjs` + `.d.mts` + 测试脚本，把「按月加载」接进新日历 `MonthWeekView` | 中等，主要在日历组件那一层重接 | 确认 `hwb` 新架构是主线 |
| **B. 把 `hwb` 合进 `main`** | `main` 直接变成修复版 | 大：78 文件差异、`main` 的旧组件被整体替换，容易把同事的 relevance UI 冲掉 | 确认 `main` 必须保持主线 |
| **C. 一条线冻结** | 保留 `hwb` 为唯一开发线，`main` 只做发布快照 | 小 | 团队接受 `hwb` 当主线 |

不管选哪条，**先别在 `main` 上继续写新功能**——两边分歧只会越拉越大。

---

## 七、给同事的三句话

1. 你跑的是 `main` 吧？`main` 上 `/api/wechat/status` 是 `spawnSync`，会卡死整个 dev server，
   看起来就像云端挂了 —— 换 `hwb` 试一下，或先把这个接口改异步。
2. 十项修复都在 `hwb` 的 `88d32e5`，`origin/hwb` 已经是 `ba03ef7`，拉下来就能用。
3. 你的 relevance（按月加载）只在 `main`，`hwb` 上还没有。定一下主线，我把它并过去。
