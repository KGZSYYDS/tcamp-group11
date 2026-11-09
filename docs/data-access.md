# 数据来源与权限分级

> 要给外部对接的字段级格式（实体 / 文件 / 接口 / 扩展投递协议），见 **[`../examples/`](../examples/)**（真实数据样例）与 **[`schema/`](./schema/)**（JSON Schema）。
> 与 `docs/schema/`（JSON Schema + 样例）。本文讲「数据从哪来、能不能拿」，那份讲「长什么样」。

> 目标：用户授权越少，展示越多。下面是 2026-11-08 实测的深大数据面，按「拿到数据需要多少权限」分层。
> 所有 URL 均为实测，标了 HTTP 结果。

## 一、分级表

| 级别 | 用户需要给什么 | 能拿到什么 | 技术路径 | 实测状态 |
|---|---|---|---|---|
| **L0 无账号** | 什么都不给 | 主站通知公告、教务部公告 | 直接 GET，无登录 | 部分可用，见 §2.4 |
| **L1 校园账号** | 统一身份认证登录（学号+密码，或企业微信扫码） | 公文通全部通知：体测、期末、讲座、开放日、报名 | CAS 会话 Cookie + 抓列表/详情 | 全站 CAS，必须登录 |
| **L2 教务/课表** | L1 之上，进入办事大厅对应应用 | 个人课表、考试安排、成绩 | eHall 应用页（appId）+ jwapp `.do` 接口；jwkw 的 `homeapp/api` | 课表已打通，考试接口已定位，见 §2.3 / §2.4 |
| **L3 消息/排班** | 企业微信授权（需学校侧建应用） | 日程、会议、审批；**不含聊天记录** | 企业微信开放平台 API | 需管理员配合，非自助 |
| **L4 本地聊天库** | 无（不需要授权，因为压根不读） | 仅群名/联系人等元数据 | 不采用，见 §三 | ❌ 主动放弃 |

**产品结论**：L0 只能撑「校园开放日/公共讲座」这种对外内容；L1 才是「体测 DDL / 期末安排」的主力，必须让用户登录一次；L2/L3 属于可选增强，不能作为默认路径。

### 1.1 数据边界（产品口径）

日历只回答「什么时候要做什么」，不回答「我学得怎么样」。

| 数据 | 收不收 | 原因 |
|---|---|---|
| 个人课表 | ✅ 收，且只对本人可见 | 日历骨架。只展示用户授权后抓到的那一份 |
| 全校课表 | ❌ 不进日历，仅数据库备用 | 全校汇总噪声太大；等真要做「蹭课」再按需查 |
| 成绩 | ❌ 不收 | 与「什么时候做什么」无关，属教务成绩单职责 |
| 考试安排 | ✅ 收（接口已通，本学期尚未排考） | 典型的日历事件 |
| 会议通知 | ✅ 收，用户主动粘贴群消息/截图 | 群聊库不解密，见 §三 |
| 公文通通知 | ✅ 收，`scope=school` | 体测、报名、讲座等公共 DDL |

**个人数据的归属**：课表不进云库，所以没有归属问题。`events` 是全校共享的公开日历，往里面塞个人课表为了做到「只让本人看见」只能打身份标记 + 让用户认领，而学号可枚举，谁先认领算谁的，等于凭空造出一个「抢占」问题。

现在的做法：采集器把课表写成**本机文件** `data/timetable/timetable-<学期>.json`，网页端在「我的」页导入后存进浏览器 `localStorage`（`lib/timetable-local.ts`）。谁的浏览器里有这个文件，就是谁的课表 —— 天然隔离，不需要哈希、不需要认领、换设备重跑一次即可。文件里同时带上姓名 / 学院 / 专业 / 年级，导入时自动填进画像，用户不用手打学院名（手填一旦和库里的字符串不一致，学院过滤就永远对不上）。

**凭据**：统一身份认证密码只在「建立会话」时用一次，**不落盘**（`scripts/lib/session.mjs` 已不提供写密码的函数，旧的 `data/.credentials.json` 读到即删）。之后 30 天靠 cookie 缓存复用，失效才重新登录。密码可经 `SZU_USER` / `SZU_PASS` 环境变量或交互式输入传入，进程结束即消失。

### 1.2 网页登录：统一认证，不是第三方账号

网页的登录凭证就是**学号 + 统一认证密码**，走本机 Node 服务端（`app/api/auth/szu`）。

**登录是可选项，不是门禁。** 首屏直接进日历：全校事件、截止日期、签到统计、粘贴导入都不需要登录。登录只多一件事 —— 自动把本学期课表同步进来。入口在右上角「登录」和「我的」页里，也可以整页不登录一直用。

未登录时能做什么：

| 功能 | 未登录 | 登录后 |
|---|---|---|
| 全校日历 / 截止日期 / 签到 / 粘贴导入 | 可用 | 可用 |
| 个人画像（学院 / 年级过滤） | 手填 | 从学籍系统自动带回 |
| 课表 | 「我的 → 从文件导入」`timetable-*.json` | 登录时自动同步，且可随时「重新同步」 |

为什么不用手机号 / 邮箱验证码：那套只证明「你是某个账号的主人」，证明不了你是在校生，也换不出课表。学校只认 CAS 的 ticket。

流程（`lib/szu/`）：

1. `casLogin(学号, 密码, 办事大厅 service)` —— 密码按 authserver 的 `encrypt.js` 规则 AES 加密后提交，拿到 TGC + 办事大厅会话
2. `casSsoInto(教务 service)` —— 带着 TGC 走 CAS 单点登录，**不再传密码**。不能登第二次：统一认证对短时间重复登录直接 401，且不告诉你是风控
3. `fetchProfile` + `collectTimetable` —— 学籍、课表、第 1 周锚点一次性取回
4. 签一个 HMAC token 写进 `httpOnly` cookie（`szu_session`，7 天）。服务端不存会话表，重启不丢

课表随登录响应一起返回，前端直接写进 `localStorage`，所以登录完就能看到课表，不用再跑命令行、再导入文件。命令行采集仍保留（批量任务用），两者共用 `data/.ehall-session.json` 会话缓存，网页登录过之后脚本不用再输密码。

密码的去向只有一条：本机进程内存 → `authserver.szu.edu.cn`。不写日志、不进云库、不落文件。会话 cookie 存在 `data/`（已被 `.gitignore` 忽略），它不是密码 —— 30 天自然过期，换设备无法使用。

失败时的三种情况要分开报，别让用户以为密码错了：

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `BAD_CREDENTIALS` | 学号或密码不对 | 让用户核对 |
| `NEED_CAPTCHA` | 该账号已被要求图形验证码 | 先用浏览器登录一次 authserver |
| `RATE_LIMITED` | 短时间重复登录触发风控（401） | **不要重试**，等 30–60 分钟 |

### 1.3 三层数据：谁存在哪（2026-11-09 定稿）

这一条是产品的地基，先定边界再谈实现：**公共的进云，个人的留本机**。

| 层 | 存在哪 | 有什么 | 谁能读 | 去重键 |
|---|---|---|---|---|
| **公共** | 云库 `events`（`scope=school`） | 公文通通知、官网公告、讲座活动、报名截止 | 所有人，含**未登录访客** | `source_url`（截止行加 `#ddl` 后缀） |
| **公共** | 云库 `events`（`scope=college/grade/…`） | 手动发的院级/年级公告 | 登录用户 | 标题 + 起始时间 |
| **个人** | 浏览器 `localStorage` | 课表、**作业截止（ddls）**、**签到记录（checkins）**、聊天记录里排出的会议/截止、自建「仅自己」事件、对公共截止的「已完成」勾选 | 只有这台设备 | 课表按学期覆盖；作业按 `course + title`；事项按 `日期+类型+标题` |
| **个人** | `data/` 下的本机文件 | 采集器中间产物、微信原始导出、会话缓存 | 只有本机 | 文件内自带 |

三条硬规则：

1. **个人数据不进 `events` 表。** 那张表是全校共享的，要「只让本人看见」就得打身份标记 + 让用户认领，而学号可枚举 —— 谁先认领算谁的，等于凭空造一个抢占问题。
2. **公共数据只在采集端要账号。** 公文通全站 CAS，但那是**采集者**（跑脚本的那台机器）登录一次；访客看的是已经落库的公共副本，自己不必有账号。
3. **密码永远不落盘。** 网页登录只在内存里用一次换 ticket；命令行走环境变量，进程结束即消失。

**2026-11-08 补漏（重要）**：上面三条以前只写在文档里，代码没全守住 —— 云库 `events` 里攒了 **211 行 `scope=personal`**（早期命令行走 `#ddl` 导入留下的），而 `events` 表对匿名 key 是全表可读，等于把这 211 条私人安排发给了每个访客。已处理：

- 备份到 `data/backup/events-personal-20261108.json`（211 行，102 KB），然后从云库删除，现在 `personal` 计数 `*/0`，全表 847 → 636 行。
- `lib/data.ts` 的 `listEvents()` 加 `scope != personal` 服务端过滤 —— 就算以后有脏数据写进去，也不会下发到浏览器。
- 日历面板和粘贴导入里的「仅自己」事件改走 `local-store.ts` 的 `addMyEvent()`（`localStorage` 键 `szu-calendar:my-events:v1`），只有选「全校/学院/年级」才写云库。

**2026-11-09 收口**：KG 定了「作业 + 截止日期属于第 2 层，不需要跨设备同步」。于是 `ddls` 与 `checkins` 整体搬进本机：

- 新增 `local-store.ts` 的 `loadDdls / addDdl / setDdlStatus / removeDdl / importDdls`（键 `szu-calendar:ddls:v1`）和 `loadCheckins / addCheckin / removeCheckin`（键 `szu-calendar:checkins:v1`）。
- `DdlPanel`、`CheckinPanel`、`CalendarPanel`、`PasteImporter`、`SyncReceiver` 全部改读本机；`lib/data.ts` 里的云端 ddls / checkins 函数已删除。
- 云库 `ddls` / `checkins` / `profiles` 三张表本来就是 **0 行**，无需迁移。
- 副作用（好的）：作业与签到在**未登录状态**下也能正常增删改，不再受 RLS 和游客态限制。
- **已删除**（2026-11-09）：`app/api/ddls`、`app/api/checkins`、`app/api/events`、`app/api/import` 与服务端 `lib/store.ts`。它们写 `data/*.json`，而网页读的是 localStorage / 云库，写完页面看不到，属早期遗留通道。

### 1.4 三条产品要求的落地对照（2026-11-09）

| 要求 | 数据来源 | 存储 | 状态 |
|---|---|---|---|
| ① 未登录看公共信息（公文通 + 官网） | `collect-board.mjs`（要账号）+ `collect-web.mjs`（免登录） | 云库 `events`，`scope=school` | ✅ 已入库：board 582 / web 45 / 其他 9，共 636 行；其中未过期 179 行。匿名 key 实测可读 |
| ② 登录后自动拿个人信息 | CAS → ehall `userInfo.json` + jwkw `currentUser.do` + 课表接口 | 姓名/学号/学院/专业/年级进 `szu_session` cookie；课表、**作业截止、签到**进 `localStorage` | ✅ 已实现，待本人真实账密实测 |
| ③ 「我的」里导入微信记录 | 微信「复制消息」粘贴（主）/ 已导出的 `.json`·`.txt`（备），浏览器内规则解析 | `localStorage` | ✅ 已实现（`components/WeChatImporter.tsx` + `lib/wechat-paste.ts`），见 §3.6 |
| 分层（非并列） | — | ①云库、②③本机 | ✅ 2026-11-09 收口：云库 `personal` 行已清零，`ddls`/`checkins` 已搬本机，云库只剩公共事件与画像 |

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
- **服务端直连已打通**（2026-11-09）：`lib/szu-lms.ts` + `/api/lms/{status,login,ddls}`。
  用户在「截止日期」页登录一次统一认证，作业就拉进本机，不装任何插件。
- 登录链是**三跳**，跟旧文档假设的「直连 authserver」不一样。必须在同一个 cookie jar 里走完：
  `broker` 那步会把 `session_code` 绑到 identity 的会话 cookie 上，另起一个 jar 会拿不到回跳。

  ```
  GET  lms.szu.edu.cn/login
   302 identity.szu.edu.cn/auth/realms/szu/protocol/cas/login?service=…&ts=…
   303 identity…/broker/cas-client/login?session_code=…&client_id=Tronclass&tab_id=…
   303 authserver.szu.edu.cn/authserver/login?service=<identity broker 回调>
   200 统一身份认证登录页（隐藏域 pwdEncryptSalt，AES-128-CBC 加密密码）
  ```

- **认证失败返回 401 + 带 `showErrorTip` 的登录页**，不是 200。按 200 判断会把「密码错」
  误报成「被风控」—— 2026-11-09 实测踩到并改掉。
- `GET /api/todos` 未登录时 302：这是「会话真的可用吗」的探针，比看页面标题可靠。
- 待办字段：`todo_list[].title / end_time / course_id / course_name`；课程名缺失时用
  `POST /api/my-courses`（`{}`）补一张 `id → name` 表。
- 会话缓存：`data/.lms-session.json`，**只存 lms 域的 cookie**（identity / authserver 的不存）。
  密码用完即弃，不写盘、不进日志。
- `extension/` 里那套 page-hook 抓接口 + DOM 兜底是历史方案（要装扩展、还得专门去畅课页面逛一圈），
  不再作为主路径；代码留着当参考。

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
| `/jwapp/sys/wdkb/modules/jshkcb/dqzc.do` | 号称「当前教学周」，**实际比教务口径大 1 周，别信** | `XN=2026-2027`、`XQ=1`、`RQ=2026-11-8` |
| `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do` | 各学期节次/校历行（含 `XQKSRQ` 学期开始日期、`ZZC` 总周次） | `XN`、`XQ` |
| `/jwapp/sys/wdkb/modules/xskcb/xskcb.do` | **课表本体** | `XNXQDM=2026-2027-1`、`XH=学号`、`SKZC=当前周` |
| `/jwapp/sys/wdkb/modules/xskcb/cxjcgx.do` | 节次关系 | `XNXQDM` |
| `/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do` | 待选/未在课表展现的课程 | — |

- `xskcb.do` 返回字段：`KCM` 课程名、`SKJS` 教师、`JASMC` 教室、`SKXQ` 星期、`KSJC`~`JSJC` 节次、`ZCMC` 周次说明、`SKZC` 周次掩码（第 n 位为 1 = 第 n 周有课）、`JXBID` 教学班 ID
- **学号 ≠ 统一认证账号**：统一认证账号是登录名，课表接口要 10 位学号，从 `GET /jsonp/userInfo.json` 的 `userId` 取（文档与代码里都不写明文）
- 门户用户信息：`GET /jsonp/userInfo.json` → `hasLogin`、`userId`（学号）、`userTypeName`（学生）、`schoolName`
- **访问姿势有坑**：`.do` 接口必须是表单 POST + `X-Requested-With: XMLHttpRequest`；接口名写错会返回 403 而不是 404，容易误判成「没权限」
- **不要反复登录**：统一认证对短时间内的重复登录返回 `401`（页面仍是登录页、无错误提示），只能等风控窗口过去。采集器因此把整条 Cookie 按域缓存到 `data/.ehall-session.json`，失效才重登
- 课表页的 `*default/index.do` 是 SPA，数据全部走 XHR；纯 HTTP 拿页面只能得到空壳。要抓真实请求用 `scripts/ehall-cdp.mjs`（本机 Chrome + CDP，只读抓包，不依赖 playwright）

### 2.4 教学管理系统 `https://jwkw.szu.edu.cn/`（真正的教务）

办事大厅只是入口壳，考试、成绩、缓考这些真正的教务功能跑在 jwkw。**接口是干净的 GET JSON**，没有 `;jsessionid` 拼 URL、没有表单 POST。

- CAS service 必须是 `https://jwkw.szu.edu.cn/jwapp/sys/homeapp/index.do`。拿办事大厅的 service 登录，这个域仍是游客。
- 域名是 `jwkw`，不是 `jwxt`（后者无 DNS）。

| 接口 | 作用 | 实测 |
|---|---|---|
| `/jwapp/sys/homeapp/api/home/currentUser.do` | 姓名 / 学号 / 当前学期 / 当前周次 | ✅ 姓名、10 位学号、`classWeek:10` |
| `/jwapp/sys/homeapp/api/home/menus.do?userType=student` | 功能菜单 | ✅ 首页 / 考试安排 / 我的考试 / 缓考申请 |
| `/jwapp/sys/homeapp/api/home/kb/xnxq.do` | 学年学期列表 | ✅ |
| `/jwapp/sys/homeapp/api/home/teachingSchedule/classWeek.do?rq=YYYY-MM-DD` | **某天属于第几周** | ✅ 8/31→1、11/2→10、11/9→11 |
| `/jwapp/sys/homeapp/api/home/teachingSchedule/list.do?rq=&lxdm=student` | 某天的课程安排 | 🟡 周日为空，正常 |
| `/jwapp/sys/homeapp/api/home/student/exams.do?termCode=2026-2027-1` | **考试安排** | 🟡 返回空数组，本学期尚未排考 |
| `/jwapp/sys/homeapp/api/home/announcement.do` | 公告 | ✅ 空 |
| `/jwapp/sys/homeapp/api/home/messages_pc.do` | 站内消息 | ✅ 空（无未读） |
| `/jwapp/sys/homeapp/api/home/student/applys.do` | 我的申请 | ✅ null |

**周次口径以 jwkw 为准**：`classWeek.do` 给出的第 1 周是 **2026-08-31**，而 ehall `wdkb` 的 `dqzc` 对同一天返回 11（假 10）。差这一周会把整学期课表排错，所以 `collect-timetable.mjs` 用 ehall 拿课表本体、用 jwkw 拿周次锚点。

### 2.5 公开可用的部分

| 地址 | 状态 | 说明 |
|---|---|---|
| `https://www.szu.edu.cn/` | 200 | 主站，无 CAS |
| `https://www.szu.edu.cn/index/tzgg.htm` | 200 | 通知公告。**先前判断「JS 渲染抓不到」是错的**：列表在静态 HTML 里，只是编码不是 UTF-8 |
| `https://www.szu.edu.cn/index/tzgg/N.htm` | 200 | 归档分页（`/1.htm`、`/2.htm`…），每页 10 条 |
| `https://www.szu.edu.cn/kxyj/xsdt.htm` | 200 | 学术动态 |
| `https://www.szu.edu.cn/index/sdxw.htm` | 200 | 深大新闻 |
| `https://jwb.szu.edu.cn/` | 200 | 教务部站，公开 |

**官网列表的正确读法**（实测 2026-11-09，`scripts/collect-web.mjs`）：

```html
<li class="wow fadeInUp">
  <a href="../info/1154/21034.htm" class="con">
    <div class="date"><div class="d1">2026</div><div class="d2">08-14</div></div>
    <h4>关于推荐作品参加…</h4>
  </a>
</li>
```

两个坑：

1. **编码骗人**：页面写着 `<meta charset="utf-8">`，实际字节是 GBK。按 UTF-8 解出来是 `鍥藉簡鑺傚亜`。必须先用 gb18030 解、看替换字符数量再决定要不要回落（和公文通同一套 `decode()`）。
2. **导航菜单混在 `<li>` 里**：一页能捞出 50+ 个 `<li>`，真正的条目只有 10 个。**只用「有没有发布日期」来分**——导航项一个日期都没有，正文条目每一条都有。按标签选容器不可靠，按日期选可靠。

另外 `xysh1/xshd.htm`（学生活动）没有日期结构，抓不出条目，已从频道表里去掉。公众号外链（`mp.weixin.qq.com`）只存标题与链接，不抓正文（单页 3MB，且正文没有更多时间信息）。

域名探测：`jwxt.szu.edu.cn`、`cx.szu.edu.cn` 均无 DNS 记录（不要再按这两个名字写代码）。

## 三、微信 / 企业微信

**结论分两层**（2026-11-08 本机实测）：
- **正文不是明文可读的**——库是 SQLCipher 加密，靠读进程内存解密属于外挂，这条路不走；
- **但用户自己的记录可以合法导出**——WeFlow 用用户自己的账号密钥读本机库，做的是「导出我自己的聊天记录」，和右键「导出」是一类事。这条路打通了，见 §3.5。

### 3.1 本机实测

| 对象 | 路径 | 结果 |
|---|---|---|
| 微信 4.x 程序 | `D:\Weixin\4.1.15.56\` | 在装，`Weixin.exe` 正在运行 |
| 微信数据目录 | 配置 `AppData\Roaming\Tencent\xwechat\config\*.ini` 指向 `D:\Weixin\chat_record\` | 该目录**是空的**；真正的库在 `D:\xwechat_files\wxid_xxx_xxxx\`（配置里的路径不是实际存储位置，别照着找） |
| 企业微信 | `%USERPROFILE%\Documents\WXWork\<企业id>\` | 在，共 81 个 `.db` |
| 企业微信消息库 | `Data\message.db`(13.7MB)、`Data\user.db`、`Data\session.db`、`Data\message_lookup.db` | **58 个非 SQLite 明文头 → SQLCipher 加密** |
| 企业微信明文库 | 23 个，其中 `Index\data_index.db`(14MB) 最大 | 是 FTS **元数据索引**：163 条会话名、125 个文件名、3107 个常用联系人，**无消息正文** |

结论：
- **群名、联系人、文件名可读**（明文索引里就有）；
- **消息正文在 `message.db` 里，SQLCipher 加密**——直接打开读不到，得让客户端自己解（见 §3.5）。

### 3.2 为什么不去解那个库

技术上可以：读进程内存拿密钥 → 解密 → 读 `message.db`。但这条路必须放弃，理由按重要性排序：

1. **封号**：注入/读内存属于客户端外挂行为，腾讯侧有检测，微信与企业微信都会封。用户装了你的日历，结果微信被封，这是产品自杀。
2. **合规过不去**：批量读取用户全部私聊与群聊，违反《个人信息保护法》的最小必要原则；即便用户点了同意，也无法证明「必要」。企业微信侧还涉及同事的通信内容——那些人没同意。
3. **版本即失效**：4.x 每次小版本都动库结构，密钥派生也会变。维护成本是一个全职逆向岗，不是学生项目该背的。
4. **企业微信官方 API 只给日程/会议/审批/应用消息，明确不给历史聊天**。要读也只能学校信息中心建应用，非自助。

### 3.3 轻量路径：用户主动交出那一条

产品要的其实不是「全部聊天」，而是「群里那条写着几点开会的通知」。所以把授权粒度降到**单条**：

| 路径 | 操作成本 | 覆盖 | 风险 |
|---|---|---|---|
| 复制群消息文字 → 粘贴 | Ctrl+C / Ctrl+V | 文字通知，最准 | 无 |
| 截图 → 粘贴 | Win+Shift+S / Ctrl+V | 含图片、长截图、转发卡片 | 无 |
| 微信「转发到文件传输助手」再复制 | 多两步 | 同上 | 无 |

实现：`lib/llm.ts` 的 `parseChatToMeetings`（文字）、`parseChatImageToMeetings`（截图，走视觉模型，不装 OCR），提示词在 `lib/meeting-prompt.mjs`，前端入口是「群聊 / 会议」Tab。

**这条路的实测效果**（2026-11-08，模拟辅导员通知群）：

| 输入 | 结果 |
|---|---|
| 9 条消息的群聊文本 | 提出 5 场会议，日期全对；正确排除了「四六级报名截止」这类非会议通知 |
| 同一段内容的聊天截图（560×900） | 提出 4 场会议（截图里本来就 4 场），日期全对 |

两个坑已修：
- **周次自相矛盾**：曾出现「下周一=11/16 但下周三=11/11」。原因是让模型自己推周次。改为程序算好「本周一 / 下周一」绝对日期写进提示词，并给出区间自检（`weekAnchors()`）。今天是周日时「下周一」应为明天（11/9），现在两条路径都给出 11/9。
- **读图形近字错**：「致理楼」被读成「数理楼」。加了一条「逐字核对、拿不准照抄不要按常识替换」的规则后修正。地点仍保留人工可编辑，不盲信。

### 3.4 提醒怎么落

提取出来的事项默认写**本机文件** `data/meetings/meetings-<日期>.json`（format `szu-calendar-personal`），网页「我的」页导入后进浏览器 localStorage，日历上以 `meeting` / `deadline` 显示。提醒分钟数记在 `note` 的 `提醒:提前N分钟` 标记里（`readRemindMinutes()` 可读回）。

**不默认写云库**：从自己的微信里排出来的事是用户级数据，进全校共享的 `events` 表就得靠身份标记 + 认领才隔离得开。确实要写（团队共用的演示数据）加 `--publish`，那时才需要学号做归属键。

当前只做「记下来 + 日历上可见」，**没有推送**——推送需要通知通道（Web Push / 企业微信应用消息 / 邮件），且要在用户设备上常驻调度，属于下一步。

### 3.5 自动路径：WeFlow 导出 + 模型提取

> 本节对应 `scripts/collect-meetings.mjs`，是本机跑通后的记录。§3.2 拒绝的是「读进程内存解密」，这里用的是另一条路：**让已经持有密钥的客户端自己把记录导出成明文**。

**工具**：[WeFlow](https://github.com/334456777/WeFlow) 5.0.1。它用用户微信自己的账号密钥打开本机库，导出指定会话的 JSON。密钥由它自己保管在 `D:\Tools\WeFlow\data`，本项目**不读、不复制、不写进仓库**。

```bash
# 装好后先确认能连上库（会打印 accountDir）
"D:/Tools/WeFlow/weflow-v5.0.1-windows-x64/weflow.exe" --json db test

# 密钥失效时的恢复：微信退出重登，再重新取一次
weflow key db --save --timeout 600
```

**本机实测（2026-11-08）**：

| 项 | 结果 |
|---|---|
| `db test` | `connected: true`，accountDir = `D:/xwechat_files\wxid_sid1ysgyl9tk22_8682` |
| 会话总数 | 788 个，其中群 227 个 |
| 单群导出耗时 | 18 条消息 / 0.7 秒 |
| 消息字段 | `localId, createTime, formattedTime, type, content, isSend, senderDisplayName, platformMessageId` |
| 图片 | 加 `--media image` 会把图片解密复制到 `media/<会话>/images/`，`content` 直接变成可读的相对路径 |
| 企业微信 | 未接。企业微信没有等价的第三方导出工具，官方 API 不给历史聊天，这块仍是空白 |

**链路**：

```
WeFlow 导出 JSON（本机）
  → 拼成「[MM-DD HH:mm] 发送者: 内容」逐行文本
  → 时间预筛：正则只留「带时间表达」的消息（普通群 ~40%、商业群 ~18% 能过）
  → 按 5000 字切片，逐片交模型（提示词与前端共用 lib/meeting-prompt.mjs）
  → 归一化日期/时间、去重、只留今天及以后
  → 认领到源消息 id → 写 data/meetings/meetings-<日期>.json（本机，默认不写库）
```

**隐私边界**：

- 原始聊天只落在 `data/wechat/`，**不上传**；`data/*` 已 gitignore；
- 只有提取出来的「标题 + 时间 + 地点 + 一句原话」写进本机文件，再进浏览器 localStorage；
- 送进模型的是消息正文，但**不发 wxid、不发头像、不发附件**；
- 只有显式 `--publish` 写云库时才会带归属键，那时 `source_url` 里是学号哈希和群名哈希，没有明文。

**两个必须知道的设计决定**：

1. **去重键不能用模型给的标题**。最初用「日期+时间+标题」，同一批消息连跑两次，模型把「提交体测督促情况反馈表」写成「填写体测督促情况反馈表」，键就对不上，每次同步多插一批近似重复。现改为「源消息 id + 日期」——模型措辞怎么变都落在同一个键上。实测连跑 3 次后收敛：第 4 次新增 0 条。
2. **认不出来源消息的条目不入库**。模型偶尔把相邻两条通知揉成一条并改写原话，这时 quote 在原文里找不到，也就无法确定身份。这类只在终端打出来提示人工判断，不硬塞进库——否则它每次都会变成一条新重复。

**收录范围**：`meeting`（要到场/上线：例会、答辩、宣讲、考试、体测）+ `deadline`（之前要交：作业、报名、表格、预约）。实测一个班级通知群 7 天 18 条消息里，会议只有 1 场（且已过），截止时间有 4–5 条——**通知群的主体是截止时间，不是会议**，所以两类都要收。

**已知波动**：模型是 `auto` 路由，同一次输入两次运行的召回可能差 1–2 条（有时把 11/20 的体测预约漏掉）。表现是「补上」而不是「重复」，配合上面的幂等键可以接受；要稳定可指定固定模型。

### 3.6 网页端导入微信（`lib/wechat-local.ts` + `lib/chat-extract.ts` + `components/WeChatImporter.tsx`）

**2026-11-09 二次修正：默认通道改成本机一键扫描。**

上一版把「长按多选 → 复制 → 粘贴」当主路径，理由是「微信没有导出按钮」。这个理由只对了一半：
微信确实不产出可读文件，但**用户电脑上的微信库可以被本机工具读**（§3.5 的 WeFlow 已经验证过）。
让用户自己去翻聊天记录、挑消息、复制，是把整个产品里最麻烦的一步丢给用户 —— 不成立。

现在的三条通道，按优先级：

| 通道 | 什么时候用 | 用户要做什么 |
|---|---|---|
| **一键扫描**（默认） | 网页跑在本机（`localhost`） | 勾群 → 点一下 |
| 粘贴 | 只导一两条；或网页部署在云端 | 复制一段 → 粘贴 |
| 选文件 | 已经用第三方工具导出过 `.json` / `.txt` | 选文件 |

#### 换一台陌生电脑怎么办（`components/WeChatSetup.tsx`）

这是最容易翻车的一环：WeFlow 可能装在任意目录，微信的存储位置也可能被改到别的盘。
两个都不能靠猜，所以路径**不写死**，而是分两层找：

| 要找的 | 查找顺序 |
|---|---|
| WeFlow | ① `data/.weflow-config.json` 用户确认过的路径 → ② `WEFLOW_EXE` → ③ 常见位置 → ④ 扫 C–H 盘 `Tools/tools/Program Files/软件/Apps` 下一层 |
| 微信数据 | ① WeFlow 配置的 `db_path`（它已经在用的，最权威）→ ② 注册表 `HKCU\Software\Tencent\{WeChat,Weixin}` 的 `FileSavePath` → ③ 文档 / 盘符根默认位置 → ④ 各盘一级目录名带「微信 / wechat / weixin」的再看一层 |

每个候选都要能读出 `wxid_*` 账号目录才算数，空壳目录不返回；`…\Backup` 一律排除
（里面也有完整账号目录，指向它「能连上」但读到的是旧快照，比报错更难发现）。

界面按「卡在第几步」分三屏，不用读文档：

```
stage=no-exe   没找到工具  → 给下载链接 + 解压位置，点「自动检测」，或手填 weflow.exe 路径
stage=no-data  工具在，但不知道库在哪 → 列出扫到的目录，一键「用这个」，或手填目录；填错当场报错
stage=no-key   目录对了，密钥过期 → 起后台任务等微信重登，前端每 5s 轮询，最长 10 分钟
stage=ready    连上了 → 显示群列表
```

写路径前一定要**先验证再落库**：`POST /api/wechat/config {wechatDir}` 会用
`weflow db scan <dir>` 扫一遍，有账号才 `weflow config set db_path`（顺带 `set wxid`）。
直接把用户填的路径塞进配置，后面只报「打不开」，用户根本分不清是路径错了还是密钥过期。

只读 `config get db_path`；**绝不调 `config list`** —— 那个输出里有 `decrypt_key` 明文。

| 接口 | 作用 |
|---|---|
| `GET /api/wechat/status` | 找 exe、找库、`db test`、版本号；缓存 20s，避免每次输入都 spawn |
| `GET /api/wechat/config` | 扫出 exe 候选 + 微信目录候选 |
| `POST /api/wechat/config` | 保存 exe 路径；或验证并写入微信目录 |
| `POST /api/wechat/key` | 后台起 `key db --save --timeout 600`，输出含密钥 → `stdio: ignore`，一个字都不返回 |

#### 一键扫描链路

```
浏览器 ──POST /api/wechat/scan──► Next.js route（跑在用户电脑上）
                                     ├─ WeFlow 导出选中群的 JSON 到 %TEMP%
                                     ├─ 读文件 → chat-extract 规则抽取
                                     └─ 删临时目录 → 只返回事项
浏览器 ◄── { items, stats } ────────┘ → mergePersonal() 写 localStorage
```

| 环节 | 做法 | 说明 |
|---|---|---|
| 探测 | `GET /api/wechat/status` | 找 exe、`db test`、版本号；结果缓存 20s，避免每次输入都 spawn |
| 选群 | `GET /api/wechat/groups` | 227 个群按「像不像通知群」打分排序，默认勾选 score ≥ 3 的前 6 个 |
| 扫描 | `POST /api/wechat/scan` | 一次最多 12 个群、30 天；单群失败不影响其他群 |
| 抽取 | `extractFromChats()` | 纯规则，**不调模型** |
| 清理 | `finally` 里 `rmSync` | 原始聊天不留盘；Windows 删不掉时也不影响结果 |

**为什么「服务端」也安全**：网页跑在 `localhost`，这个 route 就在用户自己电脑上执行，
不走网络。返回给前端的只有事项（标题/时间/地点/一句原话），没有 wxid、头像、成员、原始消息列表。
部署到云端时 `available:false`，前端自动收起自动通道 —— 不做「假装能用」的降级。

#### 手机上的记录怎么进来

手机微信不产出可读文件，但能把记录**搬到电脑上**：
「我 → 设置 → 通用 → 聊天记录迁移与备份 → 迁移到电脑」。迁完之后电脑微信里就有了，
WeFlow 直接能读，用户不需要再做别的。界面上这句话写在「已连上」状态条下面。

#### 实测（2026-11-09，本机 227 群 / 微信 4.0）

| 场景 | 结果 |
|---|---|
| `/api/wechat/status` | `available:true, connected:true, 5.0.1` |
| `/api/wechat/groups` | 227 个群，2s 内返回 |
| 扫描 2 个群（7 天） | 2.4s，84 条消息 |
| 家教群 1476 条 | **0 条事项**（表单广告全被过滤） |
| 腾班通知群 14 条 | 6 条事项：5 个截止 + 1 个会议 |
| 扫描后临时目录 | 已清空 |

#### 本轮修的四个真实缺陷

1. **WeFlow 的 `type` 是中文**（`"文本消息"` / `"引用消息"`），旧代码只认 `1` / `"text"`，
   把真实导出文件喂进去会得到 0 条。之前从没拿真实文件测过 —— 这是最贵的那个 bug。
2. **引用消息的引用块污染判定**。引用块里有「交流会」「活动」，会把「简历 11 月 6 日截止」
   判成会议。现在先在 `fromWeFlowJson` 里剥掉 `[引用 …]`。
3. **分类要「截止优先」**。凡是出现「截止 / 截至 / 前提交 / X 日前」，主体基本都是截止；
   旧逻辑按「有没有出现会议词」判，实测全判反。
4. **家教/中介的表单广告**（`订单 xx【地址】xx【学科】xx`）。每条都带地址和数字，
   规则没法用时间表达排除，但它们不是日程。判据：方括号标签 ≥ 3，或「地址 + 科目/年级」同时出现。

#### 备用通道：粘贴

`lib/wechat-paste.ts` 把各端复制格式归一成 `[YYYY-MM-DD HH:mm] 昵称: 内容`：

| 格式 | 样子 |
|---|---|
| A 电脑微信多选复制 | `张三  2026-11-09 10:23` + 下一行正文 |
| B 带日期分隔行 | `————— 2026年11月9日 —————`，下面 `张三 10:23` |
| C 昵称冒号式 | `辅导员：明天下午三点开会` |
| D 裸一段通知 | 直接粘一句话，无昵称无时间戳 |
| E 无年份带时间 | `班群 11-20 14:30` |

| 环节 | 做法 |
|---|---|
| 同意 | 复选框，未勾选时所有按钮 disabled。文案明说「内容不上传、临时文件立即删除」 |
| 输入 | 扫描（主）/ 文本框粘贴 / `showDirectoryPicker()` / `<input webkitdirectory>` / 多选文件 |
| 抽取 | 纯正则 + 日期算术，**不调模型**（调模型就等于把正文发出去） |
| 落库 | `mergePersonal()` 按「日期+类型+标题」去重后写 `localStorage` |

规则层的能力边界（8 条模拟群聊 + 5 种粘贴格式实测，全部命中）：

| 支持 | 例子 |
|---|---|
| 相对日 | 今天 / 明天 / 后天 / 今晚 / 明早 |
| 周几 | 本周四 / 下周一 / 周四前 |
| 月日、年月日 | 11月20日前 / 2026年12月3日 |
| 钟点 | 14:30 / 下午三点 / 晚上七点半 / **下午两点**（「两」曾漏） |
| 时间段 | 14:30-16:00 → 补 `endAt` |
| 类型判定 | 含「截止/日前/前交」→ 截止；含「会议/讲座/答辩/体测…」→ 会议 |
| 地点 | 「地点：致理楼201」「在图书馆报告厅」 |
| 多句消息 | 「收到。另外四六级报名 11月20日前截止」→ 取有信息量的那句当标题 |

**排不出来的**：一句话里塞了三件事、纯图片通知、跨消息才拼得出的时间（「时间同上」）。
这些在命令行 + 模型那条路能补，网页这条路会漏 —— 所以导入结果允许用户自己删，而不是假装全对。

两个必须注意的顺序问题：

1. **「月日」要排在「周几」前面解析**。正文常写「12月3日（周四）」，先匹配周几会算成本周四，日期整体偏两个月。实测出现过。
2. **标题不能只看第一句**。群聊里「收到。」开头极常见，只看首句会把整条当噪声丢掉（`11月20日前截止` 就这样被吞过）。现在改为「挑第一句含时间/动作线索的」。

## 四、采集器用法

**凭据**：统一身份认证密码只在「建会话」时用一次，**不写磁盘**。可以交互式输入，也可以用环境变量传入（推荐，写在命令那一行里，进程结束就没了）：

```bash
SZU_USER=2024xxxxxx SZU_PASS='***' npm run collect:profile
```

会话（cookie）会缓存到 `data/.ehall-session.json`、`data/.jwkw-session.json`，30 天内复用；失效才需要密码。统一认证对短时间重复登录返回 401，因此**不要**随手加 `--relogin`。

```bash
# 1. 档案：姓名 / 学号 / 学院 / 专业 / 年级 → data/profile.json
#    学院、专业由系统从 ehall + jwkw 取，不需要用户手填
npm run collect:profile

# 2. 公文通 → data/board/notices-YYYYMMDD.json，再入库（scope=school，按 source_url 去重）
npm run collect:board -- --login --pages 5
npm run ingest:notices

# 2b. 官网（免登录）→ data/web/notices-web-YYYYMMDD.json，再入库（source=web）
npm run collect:web                       # 默认 3 个频道 × 2 页
npm run collect:web -- --pages 5 --channels tzgg,xsdt
npm run ingest:notices -- --source web    # 自动读 data/web/notices-web-latest.json

# 两个源可以一天跑一次，采集是增量的（seen.json 记住已抓过的 id）。
# notices-latest.json 是累积快照，不是本次增量 —— 详见「踩过的坑」。

# 3. 课表 → data/timetable/timetable-<学期>.json（本机文件，默认不写云库）
#    跑完到网页「我的」→ 导入文件，存进浏览器 localStorage
npm run collect:timetable
npm run collect:all                   # profile + timetable 一次跑完

# 4. 群聊 → 会议/截止（需要 WeFlow，见 §3.5）
npm run meetings:list                 # 先看有哪些群（分数只作「像不像通知群」的参考）
npm run meetings:all                  # 扫全部 227 个群 → data/meetings/meetings-<日期>.json
npm run collect:meetings -- --groups "群名A,群名B" --days 3
npm run collect:meetings -- --meetings-only   # 只要会议，不要截止
npm run collect:meetings -- --no-filter       # 关掉时间预筛（全量送模型，慢且贵）
npm run meetings:publish              # 确实要写云库时才用（需要学号做归属标记）

# 课表排障
npm run collect:timetable -- --dry-run      # 只看解析结果
npm run collect:timetable -- --week1 2026-08-31   # 教务周次接口不可用时钉住第 1 周周一
npm run collect:timetable -- --file <xskcb响应.json>   # 离线跑解析
```

**两份产出都只落本机**：`data/timetable/*.json`（课表，带姓名/学院/专业）和 `data/meetings/meetings-*.json`（群聊排出的事）。前者 format 是 `szu-calendar-timetable`，后者是 `szu-calendar-personal`，网页端一个「导入文件」按钮两种都认，分别存进 `localStorage` 的两个键。重复导入会按「日期+类型+标题」合并，不会越导越多。

调试用参数：`--save-raw` 存原始 HTML 到 `data/board/raw/`，`--from-html <file>` 离线验证解析，`--dry-run` 不落盘。

抓 SPA 的 XHR（定位新接口时用）：`node scripts/ehall-cdp.mjs --url "<页面>" --service "<CAS service>"`，
走本机 Chrome + CDP，不装 playwright；结果在 `data/tmp/cdp-requests.log`。

验证群聊 → 会议的提取效果（改提示词后先跑这个，不用起前端）：

```bash
node scripts/test-meetings.mjs data/tmp/chat-sample.txt     # 文字
node scripts/test-meetings.mjs --image data/tmp/chat-shot.png   # 截图
```

## 五、还没做完 / 待确认

- [x] 公文通列表页 / 详情页解析（已用真实 HTML 校准，518 条全栏目可采）
- [x] eHall 应用枚举（登录后）→ 课表 appId `4770397878132218`
- [x] 课表接口打通（7 门课 / 207 次上课事件）
- [x] 周次锚点改用教务 jwkw 口径（`2026-08-31` = 第 1 周）
- [ ] 考试安排：jwkw `/student/exams.do` 已通，本学期尚无排考数据，等期末验证字段
- [x] ~~成绩~~：**不做**。appId `4768574631264620`（本科）已定位，但与日历无关，见 §1.1
- [x] 个人课表归属：**不再进云库**。改为本机文件 + 浏览器导入，无认领、无抢占（2026-11-08 重构）
- [x] 档案自动匹配：`collect:profile` 从 ehall/jwkw 取学院专业年级，随课表文件带入画像（2026-11-08）
- [x] 凭证处理：密码不落盘，旧 `.credentials.json` 读到即删（2026-11-08）
- [x] 群聊 → 会议：复制文字 / 截图两条路都通，提示词已按实测调过（2026-11-08）
- [x] 群聊全量扫描：`--all-groups` 扫全部群 + 时间预筛，默认只写本机文件（2026-11-08）
- [x] 群聊自动采集：WeFlow 导出 → 模型提取 → 本机文件，本机跑通并收敛（2026-11-08，见 §3.5）
- [x] 截止时间：`kind=deadline` 已接入（通知群里这类才是大头）
- [x] 公文通截止抽取：`lib/deadline.mjs` 从正文抽「报名/提交截止」，一条通知可双行入库（活动行 + 截止行），
      实测 518 条通知 → 31 条截止行（未过期 22 条）；教师申报/结项、公示、试用到期已过滤（2026-11-08）
- [x] 「截止日期」统一视图：`lib/deadlines.ts` 合并 ddls 表 + 公文通 kind=deadline + 本机群聊，
      按「日期+标题」去重（公文通优先），`components/DdlPanel.tsx` 展示并按来源筛选（2026-11-08）
- [x] 网页登录改用统一认证：学号 + 密码 → 本机服务端换 ticket → 签 cookie，登录同时带回课表与档案（2026-11-08，见 §1.2）
- [x] 登录降级为可选功能：不再拦首屏，未登录照样用日历 / 截止 / 导入，登录入口收进「我的」（2026-11-08）
- [x] 官网采集：`scripts/collect-web.mjs` 抓通知公告 / 学术动态 / 深大新闻，免登录；
      实测 3 频道 × 2 页 = 40 条带日期条目，入库 45 行（`source=web`）（2026-11-09，见 §2.5）
- [x] 采集器共用入库口：`ingest-notices.mjs --source board|web`，两源字段同构（2026-11-09）
- [x] 网页端本地导入微信：同意门 + 目录选择 + 浏览器内规则抽取 + 写 localStorage（2026-11-09，见 §3.6）
- [x] 微信导入改「复制粘贴」优先 + 界面内写清操作步骤，并明说微信文件夹里的 .db 不可读（2026-11-09，见 §3.6）
- [x] 作业截止（`ddls`）与签到（`checkins`）搬进本机 `localStorage`，云库对应表停用（2026-11-09，见 §1.3）
- [x] 网页登录端到端实测（2026-11-09）：真实账密 → `POST /api/auth/szu` 200，
      返回档案 + 课表 7 门课 / 207 节，`jwkwOk: true`，已下发会话 cookie。
      遗留：`profile.major`、`className` 仍为空（学籍接口没给这两个字段），待查
- [x] 微信导入主路径改为本机一键扫描：探测 → 选群 → WeFlow 导出 → 规则抽取 → 本机；粘贴降为备用（2026-11-09，见 §3.6）
- [x] 陌生电脑引导：工具/微信目录自动查找 + 三步向导（装工具 / 认目录 / 等密钥），路径可手填且写入前先验证（2026-11-09，见 §3.6）
- [x] 畅课作业：服务端三跳登录 + `GET /api/todos` → 写本机 `localStorage`，`components/LmsSync.tsx` 提供登录与一键同步（2026-11-09，见 §2.2）
- [x] 畅课全链路实测（2026-11-09）：真实账密 → `POST /api/lms/login` 200 `{ok:true}` →
      `/api/lms/status` loggedIn → `/api/lms/ddls` 200 返回 **8 条作业**，8/8 带可点开的 `url`
      （实测可取形态是 `/course/{cid}/learning-activity#/material/{tid}`，其余 5 种全 404）
      遗留：前端「一键同步」写 localStorage 的浏览器侧还没点过一次（`LmsSync` 已加进页面自动同步）
- [ ] 企业微信：没有等价的导出工具，官方 API 不给历史聊天；只能靠复制/截图
- [ ] 群图片里的时间安排：`--media image` 已能把图片解密出来，但还不能自动判断哪张图是时间表，需要先按上下文筛图再交视觉模型
- [ ] 采集调度：现在要手动跑，应该挂成每天定时（配合「只采上次之后的新消息」）
- [ ] 公共数据的「新鲜度」没有展示：库里 `source_url` 能查到，但页面没说「这批数据是几号采的」。
      未登录用户看到旧通知时无从判断，应该在公共列表加一个 `updatedAt`
- [ ] 会议提醒推送：当前只记录提醒分钟数，没有发通知的通道；需要 Web Push 或企业微信应用消息
- [ ] 会议精神：截图 OCR 仍有偶发形近字错误，考虑对地点做「字库白名单」校验（致理楼/文科楼等）
- [ ] 课表事件当前 `kind=other`，等前端确定要不要加 `class` 类型再改
- [ ] 创新领航讲座：公文通「讲座」栏目已能采到，是否另有独立报名入口待确认

## 六、踩过的坑（按时间倒序）

| 现象 | 原因 | 修法 |
|---|---|---|
| 群聊里「收到。另外四六级报名 11月20日前截止」整条被丢 | `cleanTitle` 只取第一句，得到「收到」（2 字）后按「标题太短」丢弃 | 按句切分，挑第一句含时间/动作线索的当标题（2026-11-09） |
| 「下午两点开班会」只排到日期，时间变 00:00 | `resolveTime` 的中文字符类 `[一二三四五六七八九十]` 漏了「两」 | 字符类加「两」，映射为 2（2026-11-09） |
| 微信「昵称：内容」粘贴后标题带「辅导员: 」前缀 | 该格式没有时间戳，走不到带时间戳的分支，整行被当正文 | `fromText` 增加「昵称：内容」分支，用文件时间兜底（2026-11-09） |
| `nick 11-20 14:30` 这种无年份消息头认不出 | 消息头正则只收完整年份或纯时间 | 增加 `M-D HH:mm` 分支，年份锚在分隔行/当前年（2026-11-09） |
| `npm run collect:board -- --list-only` 之后，截止时间少了一大半 | list-only 把 1.5MB 的 `notices-latest.json`（带正文）覆盖成 150KB 的纯列表，而 ingest 默认读 latest | list-only 改写到 `notices-list-<日期>.json`；latest 改成**累积合并**（按 id 归并），不再是「本次增量」 |
| 官网列表「抓不到」 | 误判为 JS 渲染。实际是静态 HTML + GBK 字节顶着 UTF-8 声明 | 先 gb18030 解，替换字符多再回落 UTF-8；用「有没有发布日期」区分正文条目与导航菜单 |
| 聊天记录里「12月3日（周四）」被排到本月底 | 先匹配「周四」再匹配月日，日期整体偏两个月 | `resolveDate` 顺序改为 年月日 → 月日 → 相对日 → 周几 |
| 「请于11月20日前将材料发送」抽不出截止 | 截止正则只收固定词组（前提交/前上交），中间夹宾语就匹配不到 | 加 `\d{1,2}[日号]\s*前`、`周X前` 两条结构式规则 |
