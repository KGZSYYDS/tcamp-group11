# 数据来源与权限分级

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

**个人数据的归属**：采集器用公共可发布密钥写库，落库的 `owner_id` 只能是 `anon`。课表事件的 `source_url` 里带「学号 SHA-256 前 16 位」（`ehall://xskcb/<hash>/<JXBID>/…`），用户登录后在「我的」页填学号认领，这些行才被改成 `owner_id=<用户 id>`。前端 `CalendarPanel` 对 `scope=personal` 只展示 `own` 为真的事件，未认领的课表不显示，并提示去认领。**学号明文不进库、不进日志**。

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
| `https://www.szu.edu.cn/index/tzgg.htm` | 200 | 通知公告页，但列表是 JS 渲染：HTML 里既没有条目也没有 iframe/列表 ajax 接口，只有访问计数 `_jsq_()`。**纯 HTTP 抓不到**，只能在浏览器上下文里取 DOM（现有插件的 `extract-page` 正好能干） |
| `https://jwb.szu.edu.cn/` | 200 | 教务部站，公开 |

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

会议事件写入 `events`，`kind=meeting`（会议）或 `kind=deadline`（截止），`scope=personal`，提醒分钟数记在 `note` 的 `提醒:提前N分钟` 标记里（`readRemindMinutes()` 可读回）。当前只做「记下来 + 日历上可见」，**没有推送**——推送需要通知通道（Web Push / 企业微信应用消息 / 邮件），且要在用户设备上常驻调度，属于下一步。

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
  → 按 5000 字切片，逐片交模型（提示词与前端共用 lib/meeting-prompt.mjs）
  → 归一化日期/时间、去重、只留今天及以后
  → 认领到源消息 id，写 events（source=wechat, scope=personal）
```

**隐私边界**：

- 原始聊天只落在 `data/wechat/`，**不上传**；`data/*` 已 gitignore；
- 只有提取出来的「标题 + 时间 + 地点 + 一句原话」进云库；
- 送进模型的是消息正文，但**不发 wxid、不发头像、不发附件**；
- `source_url` 里只有学号哈希和群名哈希，没有明文。

**两个必须知道的设计决定**：

1. **去重键不能用模型给的标题**。最初用「日期+时间+标题」，同一批消息连跑两次，模型把「提交体测督促情况反馈表」写成「填写体测督促情况反馈表」，键就对不上，每次同步多插一批近似重复。现改为「源消息 id + 日期」——模型措辞怎么变都落在同一个键上。实测连跑 3 次后收敛：第 4 次新增 0 条。
2. **认不出来源消息的条目不入库**。模型偶尔把相邻两条通知揉成一条并改写原话，这时 quote 在原文里找不到，也就无法确定身份。这类只在终端打出来提示人工判断，不硬塞进库——否则它每次都会变成一条新重复。

**收录范围**：`meeting`（要到场/上线：例会、答辩、宣讲、考试、体测）+ `deadline`（之前要交：作业、报名、表格、预约）。实测一个班级通知群 7 天 18 条消息里，会议只有 1 场（且已过），截止时间有 4–5 条——**通知群的主体是截止时间，不是会议**，所以两类都要收。

**已知波动**：模型是 `auto` 路由，同一次输入两次运行的召回可能差 1–2 条（有时把 11/20 的体测预约漏掉）。表现是「补上」而不是「重复」，配合上面的幂等键可以接受；要稳定可指定固定模型。

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

# 4. 群聊 → 会议/截止（需要 WeFlow，见 §3.5）
npm run meetings:list                 # 先看有哪些群、哪些像通知群（带分数）
npm run collect:meetings -- --dry-run # 只看提取结果
npm run collect:meetings              # 按 data/meeting-sources.json 正式跑
npm run collect:meetings -- --groups "群名A,群名B" --days 3
npm run collect:meetings -- --meetings-only   # 只要会议，不要截止

# 只想看看解析结果、不写库
npm run collect:timetable -- --dry-run
# 会话失效时的排障顺序：先复用缓存，再重登
npm run collect:timetable -- --relogin
# 周次锚点错了要整批重来（先删 source=ehall 再写）
npm run collect:timetable -- --replace
# 教务周次接口不可用时，用已知日期钉住第 1 周周一
npm run collect:timetable -- --week1 2026-08-31
```

调试用参数：`--save-raw` 存原始 HTML 到 `data/board/raw/`，`--from-html <file>` 离线验证解析，`--dry-run` 不落盘，
`--file <xskcb 响应 json>` 离线跑课表解析。

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
- [x] 课表接口打通并入库（7 门课 / 207 次上课事件）
- [x] 周次锚点改用教务 jwkw 口径（`2026-08-31` = 第 1 周），已按 `--replace` 整批重算
- [ ] 考试安排：jwkw `/student/exams.do` 已通，本学期尚无排考数据，等期末验证字段
- [x] ~~成绩~~：**不做**。appId `4768574631264620`（本科）已定位，但与日历无关，见 §1.1
- [x] 个人课表归属：学号哈希 + 「我的」页认领，`scope=personal` 只显示本人（2026-11-08）
- [x] 群聊 → 会议：复制文字 / 截图两条路都通，提示词已按实测调过（2026-11-08）
- [x] 群聊自动采集：WeFlow 导出 → 模型提取 → 入库，本机跑通并收敛（2026-11-08，见 §3.5）
- [x] 截止时间：`kind=deadline` 已接入（通知群里这类才是大头）
- [ ] 企业微信：没有等价的导出工具，官方 API 不给历史聊天；只能靠复制/截图
- [ ] 群图片里的时间安排：`--media image` 已能把图片解密出来，但还不能自动判断哪张图是时间表，需要先按上下文筛图再交视觉模型
- [ ] 采集调度：现在要手动跑，应该挂成每天定时（配合「只采上次之后的新消息」）
- [ ] 会议提醒推送：当前只记录提醒分钟数，没有发通知的通道；需要 Web Push 或企业微信应用消息
- [ ] 会议精神：截图 OCR 仍有偶发形近字错误，考虑对地点做「字库白名单」校验（致理楼/文科楼等）
- [ ] 课表事件当前 `kind=other`，等前端确定要不要加 `class` 类型再改
- [ ] 创新领航讲座：公文通「讲座」栏目已能采到，是否另有独立报名入口待确认
