# examples · 真实数据样例

这里的 JSON 都是**真跑出来的**（2026-11-09），不是手编的假数据。敏感值（学号、姓名、wxid）已脱敏，结构一字未改。

字段定义见 [`docs/schema/`](../docs/schema/)，同名 `.schema.json` 可直接校验；跑 `python scripts/validate-contract.py` 会全部校一遍。

## 一、实体与文件

| 文件 | 是什么 | 谁产出 / 谁消费 |
|---|---|---|
| `cloud-events.json` | 云库 `events` 表真实行（snake_case） | 采集器写入 / 云端存储 |
| `app-events.json` | 同一批数据经 `listEvents()` 转成前端形态（camelCase） | 浏览器读 |
| `ddls-lms.json` | `GET /api/lms/ddls` 真实返回，8 条畅课作业 | 服务端捞 / 前端 `importDdls()` 写入 |
| `ddls-local.json` | localStorage `szu-calendar:ddls:v1` 的值 | 本机存储 |
| `checkins-local.json` | localStorage `szu-calendar:checkins:v1` 的值 | 本机存储 |
| `personal-items.json` | 群聊抽出的事项（`PersonalItem[]`） | 微信扫描 / 本机存储 |
| `sync-payload.json` | 浏览器扩展 → 网页的 `postMessage` 消息 | 扩展发 / 页面收 |
| `files/timetable-2026-2027-1.json` | 真实课表，7 门课 207 节，第 11 周 | 采集器产出 / 「我的 → 导入」消费 |
| `files/personal-2026-11-08.json` | 真实的个人事项文件（注意同时含 `events` 和 `meetings` 两套结构） | 同上 |
| `files/profile.json` | 画像（登录后从学籍接口取回） | 登录带回 / 相关性过滤 |
| `files/meeting-sources.json` | 群订阅配置，`data/meeting-sources.example.json` 的完整形状 | 人工编辑 / `collect:meetings` 读 |
| `sources/lms-todos-raw.json` | 畅课 `GET /api/todos` 原始响应 | 上游 |
| `sources/weflow-chatroom.json` | WeFlow `db export` 导出的聊天 JSON | 上游 |
| `sources/board-notice.json` | 公文通列表页抓下来的单条 | 上游 |

**全量通知列表不在这里，就在仓库里**：`data/board/notices-latest.json`（556 条）和
`data/web/notices-web-latest.json`（40 条）。它们本身就是最真实的样例，数组元素形状见
`docs/schema/notice.schema.json`。

## 二、HTTP 接口（`api/`）

每个文件都是 `{ method, path, request?, response... }`，`response` 是**真实响应原文**（只截条数、不改字段）。

| 文件 | 接口 | 要记住的 |
|---|---|---|
| `api/auth-szu.json` | `POST /api/auth/szu` | 一次请求同时带回 `profile` + `timetable`；密码错 401 `BAD_CREDENTIALS` |
| `api/auth-session.json` | `GET/DELETE /api/auth/session` | 只读 cookie，未登录 `user:null` |
| `api/lms-login.json` | `POST/DELETE /api/lms/login` | **密码错返回 401，不是 200** |
| `api/lms-status.json` | `GET /api/lms/status` | `ageDays=0` 表示今天登录 |
| `api/wechat-status.json` | `GET /api/wechat/status` | `stage` 四档诊断：`no-exe` / `no-data` / `no-key` / `ready` |
| `api/wechat-groups.json` | `GET /api/wechat/groups` | 227 个群全量返回，`score` 只影响排序 |
| `api/wechat-scan.json` | `POST /api/wechat/scan` | 最多 12 群 / 30 天；原始聊天正文不返回 |
| `api/wechat-config.json` | `GET/POST /api/wechat/config` | POST `wechatDir` 会真验证一遍目录，不通过就 400 |
| `api/wechat-key.json` | `GET/POST /api/wechat/key` | 要用户微信**退出重登**；密钥一个字都不返回 |
| `api/board-ingest.json` | `POST /api/board/ingest` | 收 `{items:[...]}` 或裸数组，按 `source_url` 去重 |

## 三、三条必须遵守的

**1. 时间有四种写法，混用必错**

| 场景 | 写法 |
|---|---|
| 云端 `events`、`/api/auth/*`、`/api/wechat/*` | 带时区：`2026-11-22T15:59:00+08:00` 或 `...Z` |
| `/api/lms/ddls` 的 `dueAt` | **UTC `Z`**，如 `2026-11-22T15:59:00.000Z`（= 北京 23:59） |
| localStorage 的 `ddls` / `checkins` | UTC `Z`（`toISOString()` 的产物） |
| 导入文件（timetable / personal） | **不带时区**的本地串：`2026-09-01T08:30:00` |

凌晨 08:00 前的截止，`toISOString()` 会把日期掉到前一天——`lib/deadlines.ts` 的去重键用
`dueAt.slice(0,10)`，所以这类条目可能算到前一天。新代码优先写 `+08:00`。

**2. 作业和签到不在云端**

它们在浏览器 localStorage，没有给第三方读的接口。要往里推，只有两条路：
- 浏览器内发 `sync-payload`（见 `sync-payload.json`）；
- 服务端自己登录畅课拉（`GET /api/lms/ddls`）。

**3. 这四个接口已废弃，别接**

`/api/ddls`、`/api/checkins`、`/api/events`、`/api/import` —— 它们写服务端 `data/*.json`，
而网页读的是 localStorage / 云库，写完页面看不到。

## 四、去重键

| 实体 | 键 |
|---|---|
| `Ddl` | `course + title`（已存在则更新截止时间，保留 `done` 状态） |
| `Event` | `sourceUrl`（同一通知的活动行与截止行共用一个 url，截止行加 `#ddl` 后缀） |
| `Notice` | `url`（`id` 跨源不唯一，board 是纯数字、web 是 `频道:/info/...`） |
| `PersonalItem` | `date + kind + title` |
| `Checkin` | 无 |

## 五、校验

```bash
pip install jsonschema
python scripts/validate-contract.py   # 退出码 0 = 全通过
```

## 六、四个坑

- `listEvents()` **不下发 `sourceUrl`**（见 `app-events.json`，确实没有这个字段）。去重是在入库端做的，前端别指望拿到它。
- `PersonalItem.note` 里的 `来自群：<群名>` 有语义，`lib/deadlines.ts` 靠它抠群名当标签。
  分隔符只认 `｜`（网页抽取）和 `·`（命令行采集器），换成别的会让标签退化成「群聊」。
- `profile.major` 与 `className` **实测是空串**（2026-11-09，学籍接口没返回）。
  别拿它们做非空校验，也别在界面上假定有值。
- 畅课的 `dueAt` 是 UTC。`2026-11-22T15:59:00.000Z` 是北京时间 11 月 22 日 23:59，
  不是 15:59 —— 直接 `slice(0,10)` 取日期在凌晨会差一天。
