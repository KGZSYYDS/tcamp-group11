# 修复记录（2026-11-10）

基线：同事的 `hwb` 分支（`2f66c3d`）。问题来源：`docs/code-review.md` 的 P0/P1 清单。
本文件只记「根因 → 改法 → 怎么验证」，不重复审计内容。

验证环境：`hwb` 分支本地，Node 22，Next 14 dev + 真实云端（636 行公共事件）。

---

## 一、P0（现在就是错的）

### P0-1 粘贴导入的自动解析全部失效

**根因**：`setState` 是异步的，`setTimeout(() => parse(), 100)` 里执行的是**上一次 render 的闭包**，
读到的 `text` / `image` 仍是空串。三处入口全中：读剪贴板、读剪贴板截图、Ctrl+V 自动解析。

**改法**（`components/PasteImporter.tsx`）
- 加 `textRef` / `imageRef`，每次 render 同步镜像最新值；
- `parse(input?: { text?: string })` 与 `parseChat(input?: { image?: string; text?: string })`
  改成**显式传参**优先，ref 兜底；
- 三个入口不再靠定时器等状态：`readClipboard` 直接 `parse({ text: content })`，
  `grabImageFromClipboard` 直接 `parseChat({ image: url, text: "" })`；
- Ctrl+V 文本仍延迟一帧（React 要先把 value 写回 state），但读的是 ref 不是闭包；
- `onClick={parse}` 改成 `onClick={() => void parse()}`，避免把事件对象当参数传入。

**验证**：类型检查通过；逻辑上四个入口都不再依赖 `setState` 的完成时机。

---

### P0-2 `/api/wechat/status` 冻结整个 dev server

**根因**：`weflowStatus()` 里是 `spawnSync`，串行跑 `--version`（超时 20s）+ `db test`（超时 60s），
外面还有 `detectWeChatDirs()` 用 `readdirSync` 扫 C–H 盘根。`spawnSync` 占满 Node 唯一主线程，
**这期间所有页面和其它接口一起停住**，20s 缓存救不了首次调用。

**改法**（`lib/wechat-local.ts` + `app/api/wechat/status/route.ts`）
1. 新增 `runAsync()`（`execFile` + Promise），等待子进程时事件循环可以继续处理请求；
2. 新增 `probeWeFlowStatus()`：异步探测，单飞（同一时刻只有一个在跑）；
3. 新增 `weflowStatusNow()` 给 HTTP 用：**立刻返回**——命中缓存给结果，否则回
   `stage:"probing"` 并在后台起探测；
4. 状态判定抽成 `assembleStatus()`，同步/异步两条路径共用，避免规则漂移；
5. `findWeFlow()` 加 60s 进程级缓存（扫盘实测约 2s，之前每次 status/groups/scan 都重扫）；
6. 缓存挂在 `globalThis` 上：dev 的 HMR 会重新求值模块，模块级变量会被清空，
   表现就是「探测完成 → 切个页面 → 又回到检测中」；
7. 前端（`WeChatImporter` + `WeChatSetup`）轮询 `probing` 直到有结论（约 18s 上限），
   `WeChatSetup` 增加 probing 态的加载 UI，不再先闪一屏「没装工具」。

**验证**
| 场景 | 修复前 | 修复后 |
|---|---|---|
| 冷启动首次请求 | 阻塞数十秒 | **36 ms** 返回 `probing` |
| 探测完成后再请求 | — | **11 ms** 返回 `ready` |
| 连续 3 次请求 | 可能反复探测 | 稳定命中缓存，均 `ready` |
| 浏览器打开「我的」 | 整站卡住 | 正常渲染「已连上本机微信（WeFlow 5.0.1）」 |

---

### P0-3 作业面板「全部」筛选下已截止条目重复渲染

**根因**：`filter==="all"` 时 `visible` 取的就是 `all`（已含 expired），`expiredVisible` 又收一遍。

**改法**（`components/DdlPanel.tsx`）：`expiredVisible` 只在 `filter === "pending"` 时计算。

**验证**：待完成 22 条、已截止 17 条，「全部」下实测 **39 条**（修复前会渲染 56 条）。

---

## 二、P1（数据会错 / 体验明显受损）

### P1-4 进「我的」会用课表副本覆盖手改的画像

**改法**（`components/ProfilePanel.tsx`）
- 优先级改为：云端 `profiles`（可能是用户手改的）> 课表副本（学籍接口原样快照）；
- 每个字段独立兜底，云端为空才用课表；
- **去掉自动回写云端**，改由「保存画像」按钮触发。

### P1-5 学院 / 年级精确比较，实际几乎匹配不上

**根因**：学籍给全称「计算机与软件学院」，公文通写「计软学院」「计算机学院」，`===` 永不成立；
年级一边是「2024 级」（带空格）一边是「2024级」。

**改法**（`lib/visibility.ts`，全仓唯一的归属判定入口）
- 抽出 `normalizeText()`：全角转半角、去空白/间隔符、小写；
- `sameAffiliation()`：剥掉「深圳大学」前缀与「学院/学部/系」后缀，再做**双向子序列包含**
  （「计软」的字符按序出现在「计算机与软件」里即命中）；
- `sameGrade()`：优先抽四位年份比较，抽不到退回文本比较；
- `isVisible()` 的 college/major/grade 分支改用新函数；
- `lib/useAgenda.ts` 的 `filterByProfile` 同步切换（原来自己写了一套 `gradeKey` 归一化），
  保证两处规则一致。

**验证**：13 项断言全过

```
计算机与软件学院 ↔ 计软学院          true（简称）
计算机与软件学院 ↔ 计算机学院        true
计算机与软件学院 ↔ 软件学院          true
深圳大学计算机与软件学院 ↔ 全称      true（带校名）
计算机与软件学院 ↔ 法学院 / 医学部   false（不误判）
建筑与城市规划学院 ↔ 建规学院        true
法学院 ↔ 医学部                      false（短名不误判）
2024 级 ↔ 2024级                     true
2024 级 ↔ 2026级                     false
```

### P1-6 公共截止的「已完成」标记随重新入库丢失

**根因**：完成标记的 key 是 `event:<自增 id>`，而 ingest 是「删了再插」，重新入库就换 id。

**改法**（`lib/deadlines.ts`）：key 改为 `event:<标题>|<日期>|<学院>`，跨批次稳定。

> 注意：这是一次性的旧标记失效（本来也会因换 id 失效），之后不再丢。

### P1-7 畅课课程名退化会让同一作业变两条

**改法**（`lib/local-store.ts` 的 `importDdls`）
- 查重先比 `url`（含 `course_id + material_id`，最稳），再退回 `course + title`；
- url 命中但课程名变化时，**更新课程名**而不是新增一条。

### P1-8 「本周一」在周三被算成下周一

**根因**：`delta = (target - cur + 7) % 7` 恒非负，只能往后推。

**改法**（`lib/chat-extract.ts`）：以周一为起点换算偏移（正数=本周内还没到，负数=已过去），
`下` 一律 +7，`本/这` 保留正负，无修饰词时负数再 +7（理解为最近的将来）。

**验证**（锚点 2026-11-11 周三）

```
「本周一」→ 2026-11-09  PASS
「下周一」→ 2026-11-16  PASS
「周五」  → 2026-11-13  PASS
```

### P1-9 同一个 events 表被拉 2–3 次，且 60s 全量轮询

**改法**（`lib/data.ts`）
- 加模块级共享缓存 `EVENTS_TTL = 5 分钟` + 在途请求复用（同一时刻只有一个请求在飞）；
- 新增 `subscribeEvents()` / `invalidateEvents()`；
- `createEvent` / `deleteEvent` 成功后主动失效，下一次读能拿到新列表；
- `listEvents({ force: true })` 可绕过缓存（手动刷新用）。

**验证**：在日历 / 作业 / 签到之间来回切 5 次，云端 `/events` 请求数 **始终为 1**
（修复前每次切回都会重新拉）。

### P1-10 粘贴导入的作业被标成「畅课」

**改法**：`PasteImporter` 导入时传 `source: "paste-import"`；`buildDeadlines` 透传该值
（`DeadlineSource`、`sourceLabel`、`DdlPanel.sourceStyle` 本来就有这个键，只是链路断了）。

---

## 三、构建与检查

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | 0 error |
| `next build` | 编译成功 / lint 与类型检查通过 / 5 个静态页生成完成 |
| 云端读取 | 636 条，与 Node 直查行数一致 |

> `next build` 最后会报一次 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，那是本机沙箱的删除拦截钩子
> 挡住了 Next 自己清理 `.next/export`，与代码无关；`.next/BUILD_ID` 已正常生成。

---

## 四、关于「同事拉不到云端数据库」

本地实测云端**完全正常**，链路没问题：

- Node 直查 `events`：636 行，约 0.9s；
- 浏览器内直接 fetch：`200`，857ms；
- 页面实际渲染（已合并同事 `1c1f30a`）：11 月日历正常铺出云端事件标题，控制台无报错；
  连续切「日历 → 作业 → 签到」三次，`/events` 全程只有 **1** 次请求（P1-9 的缓存生效）。

所以不是网络、不是权限、不是 RLS。有两个可能原因，**按可能性排序**：

**(1) 他跑的是 `main`，踩了 P0-2（最可能）**

`main` 上 `app/api/wechat/status/route.ts` 仍是同步 `weflowStatus()`，
`components/WeChatImporter.tsx:159` 进「导入」页就自动调它，内部 `spawnSync` 会阻塞
整个 Node 事件循环，期间所有请求（含云端 `events`）全部排队 —— 看起来就是「拉不到云端」。
详见 `docs/branch-divergence.md`。

**(2) 他本地没装新依赖**

`hwb` 新增了 `motion`、`lucide-react`、`@fontsource-variable/manrope`，
缺这三个 dev 会 `Module not found` 编译失败，页面空白 —— 同样像「拉不到数据」。

排查顺序：
1. 先确认分支：`git branch --show-current`，是 `main` 就切 `hwb`（修复都在 `hwb`）；
2. `npm install`（把三个新依赖装上）；
3. 删掉 `.next` 重新 `npm run dev`（旧产物里可能缓存了已删除的路由）；
4. 浏览器控制台看有没有 `Failed to fetch` / CORS；
5. 还不行就访问 `/api/auth/session` 看服务端是否正常。

> 注意：新版界面是纯客户端渲染，首屏 HTML 固定是「加载中…」。用 `curl` 判断
> 「没有数据」会误判，必须在浏览器里等 2–3 秒看实际渲染结果。
> 另外 SDK 的鉴权头是 `x-wb-webapp-access-key`，写成 `apikey` 会稳定返回 403 —— 这个
> 也很容易被当成「云端挂了」。

---

## 五、没动的地方（避免误伤）

- 没改任何 API 路由的入参 / 出参形状（除 `stage` 新增 `"probing"`）；
- 没给 `dueAt` 加时区（畅课 UTC / 群聊 +08:00 / 课表本地串，三处口径不同是故意的）；
- 没动 `lib/pipeline`、`lib/ingest`（同事的数据管道，尚未接界面）；
- P2 批次（`requireLocal` 校验、`deleteEvent` 权限谓词、`szu-cal-hidden` 命名等）未处理。
