# examples · 真实数据样例

这里的 JSON 都是**真跑出来的**（2026-11-09），不是手编的假数据。敏感值（学号、姓名、wxid）已脱敏，结构一字未改。

字段定义见 [`docs/schema/`](../docs/schema/)，同名 `.schema.json` 可直接校验。

## 文件对照

| 文件 | 是什么 | 谁产出 / 谁消费 |
|---|---|---|
| `cloud-events.json` | 云库 `events` 表真实行（snake_case） | 采集器写入 / 云端存储 |
| `app-events.json` | 同一批数据经 `listEvents()` 转成前端形态（camelCase） | 浏览器读 |
| `ddls-lms.json` | `GET /api/lms/ddls` 真实返回，8 条畅课作业 | 服务端捞 / 前端 `importDdls()` 写入 |
| `ddls-local.json` | localStorage `szu-calendar:ddls:v1` 的值 | 本机存储 |
| `checkins-local.json` | localStorage `szu-calendar:checkins:v1` 的值 | 本机存储 |
| `personal-items.json` | 群聊抽出的事项（`PersonalItem[]`） | 微信扫描 / 本机存储 |
| `sync-payload.json` | 浏览器扩展 → 网页的 `postMessage` 消息 | 扩展发 / 页面收 |
| `files/timetable-2026-2027-1.json` | 真实课表，7 门课 207 节，第 10 周 | 采集器产出 / 「我的 → 导入」消费 |
| `files/personal-2026-11-08.json` | 真实的个人事项文件（注意同时含 `events` 和 `meetings` 两套结构） | 同上 |
| `sources/lms-todos-raw.json` | 畅课 `GET /api/todos` 原始响应 | 上游 |
| `sources/weflow-chatroom.json` | WeFlow `db export` 导出的聊天 JSON | 上游 |
| `sources/board-notice.json` | 公文通列表页抓下来的单条 | 上游 |

## 三条必须遵守的

**1. 时间有三种写法，混用必错**

| 场景 | 写法 |
|---|---|
| 云端 `events`、所有 HTTP 接口 | 带时区：`2026-11-22T15:59:00+08:00` 或 `...Z` |
| localStorage 的 `ddls` / `checkins` | UTC `Z`（`new Date().toISOString()` 的产物） |
| 导入文件（timetable / personal） | **不带时区**的本地串：`2026-09-01T08:30:00` |

凌晨 08:00 前的截止，`toISOString()` 会把日期掉到前一天——`lib/deadlines.ts` 的去重键用 `dueAt.slice(0,10)`，所以这类条目可能算到前一天。新代码优先写 `+08:00`。

**2. 作业和签到不在云端**

它们在浏览器 localStorage，没有给第三方读的接口。要往里推，只有两条路：
- 浏览器内发 `sync-payload`（见 `sync-payload.json`）；
- 服务端自己登录畅课拉（`GET /api/lms/ddls`）。

**3. 这四个接口已废弃，别接**

`/api/ddls`、`/api/checkins`、`/api/events`、`/api/import` —— 它们写服务端 `data/*.json`，而网页读的是 localStorage / 云库，写完页面看不到。

## 去重键

| 实体 | 键 |
|---|---|
| `Ddl` | `course + title`（已存在则更新截止时间，保留 `done` 状态） |
| `Event` | `sourceUrl`（同一通知的活动行与截止行共用一个 url，截止行加 `#ddl` 后缀） |
| `PersonalItem` | `date + kind + title` |
| `Checkin` | 无 |

## 校验

```bash
pip install jsonschema
python scripts/validate-contract.py   # 退出码 0 = 全通过
```

## 两个坑

- `listEvents()` **不下发 `sourceUrl`**（见 `app-events.json`，确实没有这个字段）。去重是在入库端做的，前端别指望拿到它。
- `PersonalItem.note` 里的 `来自群：<群名>` 有语义，`lib/deadlines.ts` 靠它抠群名当标签。分隔符只认 `｜`（网页抽取）和 `·`（命令行采集器），换成别的会让标签退化成「群聊」。
