# 数据来源与权限分级

> 目标：用户授权越少，展示越多。下面是 2026-11-08 实测的深大数据面，按「拿到数据需要多少权限」分层。
> 所有 URL 均为实测，标了 HTTP 结果。

## 一、分级表

| 级别 | 用户需要给什么 | 能拿到什么 | 技术路径 | 实测状态 |
|---|---|---|---|---|
| **L0 无账号** | 什么都不给 | 主站通知公告、教务部公告 | 直接 GET，无登录 | 部分可用，见 §2.4 |
| **L1 校园账号** | 统一身份认证登录（学号+密码，或企业微信扫码） | 公文通全部通知：体测、期末、讲座、开放日、报名 | CAS 会话 Cookie + 抓列表/详情 | 全站 CAS，必须登录 |
| **L2 教务/课表** | L1 之上，进入办事大厅对应应用 | 个人课表、考试安排、成绩 | eHall 应用页（appId）+ jwapp `.do` 接口 | 课表已打通，见 §2.3 |
| **L3 消息/排班** | 企业微信授权（需学校侧建应用） | 日程、会议、审批；**不含聊天记录** | 企业微信开放平台 API | 需管理员配合，非自助 |

**产品结论**：L0 只能撑「校园开放日/公共讲座」这种对外内容；L1 才是「体测 DDL / 期末安排」的主力，必须让用户登录一次；L2/L3 属于可选增强，不能作为默认路径。

## 二、实测明细

### 2.1 公文通 `https://www1.szu.edu.cn/board/`

- `302` → `https://authserver.szu.edu.cn/authserver/login?service=...caslogin.asp?rurl=%2Fboard%2F`
- **没有公开 API，也没有 RSS**。`/board/list.asp`、`/board/index.asp` 均被 CAS 拦截（前者重定向死循环）
- 登录页能力：
  - 企业微信扫码登录（`/authserver/qrCode/getCode?uuid=`）
  - 学号/工号 + 密码
  - 「7 天免登录」勾选 → 勾上后 Cookie 有效期 7 天，这对定时采集很关键
  - 密码前端 AES 加密：隐藏域 `pwdEncryptSalt`（每次会话随机），提交字段是 `password`，`passwordText` 是只读展示框
  - 图形验证码按账号判定：`GET /authserver/checkNeedCaptcha.htl?username=<学号>` → `{"isNeed":false}`，只在多次失败后置 true
- **采集方式**：登录一次拿 Cookie，`scripts/collect-board.mjs` 跑批量；不要写死账号密码

### 2.2 畅课 `https://lms.szu.edu.cn/`

- `/` → `302 /login`
- demo 的插件已接（`extension/`），走 `page-hook` 抓接口 + DOM 兜底，作业和课程名都能拿

### 2.3 办事大厅 `https://ehall.szu.edu.cn/new/index.html`

- `200`，是金智 amp 门户的 SPA 外壳，公开可加载；应用列表在接口后面，未登录拿不到
- 应用入口形态：`/appShow?appId=<数字>`
- **登录后枚举应用列表**：`GET /jsonp/serviceCenterData.json`（约 68 KB，81 个应用，含 appId / 名称 / 是否 `hasPermission`）
- 已定位：
  - 我的课表 `4770397878132218`
  - 全校课表查询 `4766960573884517`
  - 我的成绩 `5101964191790615`、成绩查询 `4768574631264620`
  - 我的考试安排 `7815927872376224`

**我的课表数据接口**（金智 jwapp，全部表单 POST，会话靠 Cookie）：

| 接口 | 作用 | 关键参数 |
|---|---|---|
| `/appShow?appId=4770397878132218` | 打开应用，302 到 `/jwapp/sys/wdkb/*default/index.do` | — |
| `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do` | 当前学年学期 | — |
| `/jwapp/sys/wdkb/modules/jshkcb/dqzc.do` | 当前教学周 | — |
| `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do` | 各学期节次/校历行（含 `XQKSRQ` 学期开始日期、`ZZC` 总周次） | — |
| `/jwapp/sys/wdkb/modules/xskcb/xskcb.do` | **课表本体** | `XNXQDM=2026-2027-1`、`XH=学号`、`SKZC=当前周` |
| `/jwapp/sys/wdkb/modules/xskcb/cxjcgx.do` | 节次关系 | `XNXQDM` |
| `/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do` | 待选/未在课表展现的课程 | — |

- `xskcb.do` 返回字段：`KCM` 课程名、`SKJS` 教师、`JASMC` 教室、`SKXQ` 星期、`KSJC`~`JSJC` 节次、`ZCMC` 周次说明、`SKZC` 周次掩码（第 n 位为 1 = 第 n 周有课）、`JXBID` 教学班 ID
- **访问姿势有坑**：`.do` 接口必须是表单 POST + `X-Requested-With: XMLHttpRequest`；接口名写错会返回 403 而不是 404，容易误判成「没权限」
- **不要反复登录**：统一认证对短时间内的重复登录返回 `401`（页面仍是登录页、无错误提示），只能等风控窗口过去。采集器因此把整条 Cookie 按域缓存到 `data/.ehall-session.json`，失效才重登
- 课表页的 `*default/index.do` 是 SPA，数据全部走 XHR；纯 HTTP 拿页面只能得到空壳。要抓真实请求用 `scripts/ehall-cdp.mjs`（本机 Chrome + CDP，只读抓包，不依赖 playwright）

### 2.4 公开可用的部分

| 地址 | 状态 | 说明 |
|---|---|---|
| `https://www.szu.edu.cn/` | 200 | 主站，无 CAS |
| `https://www.szu.edu.cn/index/tzgg.htm` | 200 | 通知公告页，但列表是 JS 渲染：HTML 里既没有条目也没有 iframe/列表 ajax 接口，只有访问计数 `_jsq_()`。**纯 HTTP 抓不到**，只能在浏览器上下文里取 DOM（现有插件的 `extract-page` 正好能干） |
| `https://jwb.szu.edu.cn/` | 200 | 教务部站，公开 |

域名探测：`jwxt.szu.edu.cn`、`cx.szu.edu.cn` 均无 DNS 记录（不要再按这两个名字写代码）。

## 三、企业微信 / 微信

**聊天记录拿不到，这是平台事实，不是策略选择。**

- 微信个人号：无任何开放接口
- 企业微信：开放平台只给「日程、会议、审批、通讯录、消息推送（应用消息）」等 API；**不提供历史聊天记录读取**。要读本地库只能注入/解密客户端，属于外挂行为，会被封号，也过不了任何合规审查
- 真要用消息侧数据（排班、老师通知），可行路径只有两条：
  1. 学校信息中心为你建企业微信应用，你拿 `corpid` + 应用 `secret`，读**日程/审批**（不是聊天）
  2. 用户手动粘贴/截图 → 走 demo 已有的「AI 粘贴导入」（`lib/llm.ts` 的 `parseDdlText`）

对产品来说第 2 条反而更稳：零授权门槛、当天能上线、不需要学校配合。

## 四、采集器用法

```bash
# 0. 只跑一次：凭据存本地 data/.credentials.json（已 gitignore）
npm run auth:save -- 482848 "密码"

# 1. 公文通 → data/board/notices-YYYYMMDD.json
npm run collect:board -- --login --pages 5

# 2. 入库（scope=school，按 source_url 去重，直接走数据面 REST）
npm run ingest:notices

# 3. 个人课表 → 云数据库（scope=personal，按 课程+周次+星期+节次 去重）
npm run collect:timetable

# 只想看看解析结果、不写库
npm run collect:timetable -- --dry-run
# 会话失效时的排障顺序：先复用缓存，再重登
npm run collect:timetable -- --relogin
# 手滑跳过一整周时，用已知日期钉住第 1 周周一
npm run collect:timetable -- --week1 2026-08-24
```

调试用参数：`--save-raw` 存原始 HTML 到 `data/board/raw/`，`--from-html <file>` 离线验证解析，`--dry-run` 不落盘，
`--file <xskcb 响应 json>` 离线跑课表解析。

## 五、还没做完 / 待确认

- [x] 公文通列表页 / 详情页解析（已用真实 HTML 校准，518 条全栏目可采）
- [x] eHall 应用枚举（登录后）→ 课表 appId `4770397878132218`
- [x] 课表接口打通并入库（7 门课 / 207 次上课事件）
- [ ] 考试安排（appId `7815927872376224`）接口待摸
- [ ] 成绩（appId `5101964191790615`）接口待摸
- [ ] 课表事件当前 `kind=other`，等前端确定要不要加 `class` 类型再改
- [ ] 创新领航讲座：公文通「讲座」栏目已能采到，是否另有独立报名入口待确认
