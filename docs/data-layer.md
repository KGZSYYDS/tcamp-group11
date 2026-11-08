# 数据层说明

> 给队友看的。看完应该知道：自己的代码该放哪、能调什么、不要碰什么。
> 最后更新：2026-11-08

---

## 1. 三层边界

```
采集（别人负责）        处理（本项目）           展示（前端负责）
─────────────────    ─────────────────     ─────────────────
抓到原文            归一化 → 抽取 → 校验      渲染日历
     │                    │                      │
     ▼                    ▼                      ▼
  RawRecord    →      EventDraft      →      EventSink 落地
```

**规矩只有一条：谁也别越界。**

| 层 | 只能做 | 不能做 |
|---|---|---|
| 采集 | 抓原文、保留发布时间与链接 | 不要抽日期、不要判断"这条跟谁有关" |
| 处理 | 清洗、抽取、去重、判可见性 | 不要发请求、不要写界面 |
| 展示 | 读数据、渲染、交互 | 不要自己判断权限、不要自己算日期 |

判权限和算日期都必须走 `lib/` 里的函数。前端自己写一套 `if (scope === 'college')`，一定和别处不一致。

---

## 2. 三个契约

### `RawRecord` —— 采集交给我方的形态

不用你按某个 JSON 结构交付，只要下面 5 件事不丢：

1. 这条记录指向哪个原始页面
2. 原文正文（未加工）
3. 发布时间
4. 来源标识
5. 重复采集同一条时，能不能给出同一个稳定 id

字段名、层级、命名风格由采集方定，我方写适配器去理解。

### `EventDraft` —— 处理层产出的草稿

关键字段：

| 字段 | 含义 | 注意 |
|---|---|---|
| `occurAt` | 事情什么时候发生 | 可能是 `null`（原文没给可核实的日期） |
| `actionDeadline` | 什么时候必须行动（报名/提交/缴费截止） | 与 `occurAt` 是两个不同时间，别混用 |
| `visibility` + `audience` | 谁能看到 | 判不准时一律往窄里落，**不会自动变成 public** |
| `confidence` | 置信度 0~1 | 低于 0.6 进人工确认，不入主数据 |
| `evidence` | 原文里的依据片段 | 前端可据此"跳到原文" |

### `EventSink` —— 落地接口

```ts
interface EventSink {
  findExisting(candidate): Promise<DedupePoolItem[]>;
  save(draft, meta): Promise<{ id, created }>;
  markPendingReview(draft, notes): Promise<void>;
}
```

已提供两个实现：

- `MemorySink`（`lib/pipeline`）：进程内，测试与演示用
- `JsonlSink`（`lib/sink`）：写 `data/drafts/*.jsonl`，本地可见

接数据库时**只需新写一个 `CloudSink`**，管道和历史调用方都不用改。

---

## 3. 新增一个采集器，三步

1. 写 `lib/ingest/adapters/<名字>.ts`，导出 `Adapter`
2. 在 `lib/ingest/adapters/index.ts` 里 `registerAdapter("<名字>", ...)`
3. 往 `fixtures/inbox/<名字>/` 放一份**原样**样本（不要美化），再跑一遍 `node scripts/check.mjs`

不要改 `lib/pipeline/` 下任何文件——格式差异应该在适配器里消化掉。

---

## 4. 怎么用

```ts
import { runPipeline } from "@/lib/pipeline";
import { adapt, auditCapabilities } from "@/lib/ingest";

const records = adapt({ collector: "gwt-board", receivedAt, payload });
const audit = auditCapabilities(records);   // 缺什么会明确告诉你

for (const record of records) {
  const result = await runPipeline(record, { extractor, pool });
  // result.draft      结构化草稿
  // result.status     ready / pending_review
  // result.fingerprint 传给 sink，避免两处各算一遍
}
```

自检：`node scripts/check.mjs`（零额外依赖，失败返回非 0）

---

## 5. 当前限制（别当它已经完成）

- **管道还没接界面**：`components/` 目前完全没有引用 `lib/pipeline`
- **草稿还没入库**：数据库没有 `visibility` / `audience` / `action_deadline` 等列，需要仓库负责人执行变更
- **没有排序与提醒**：前端形态未定，故意留空
- **游客可见性只在代码层成立**：真正的边界要等 RLS 收紧

---

## 6. 两条红线

1. **不要在前端自己写权限判断**。调 `isVisible(item, viewer)`，判不准它会让内容看不见，而不是让不该看的人看见。
2. **不要在浏览器代码里 import `lib/sink/`**。那里依赖 `node:fs`，打包会炸。
