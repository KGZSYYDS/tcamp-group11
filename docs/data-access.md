# 数据来源与权限分级

> 目标：用户授权越少，展示越多。下面是 2026-11-08 实测的深大数据面，按「拿到数据需要多少权限」分层。
> 所有 URL 均为实测，标了 HTTP 结果。

## 一、分级表

| 级别 | 用户需要给什么 | 能拿到什么 | 技术路径 | 实测状态 |
|---|---|---|---|---|
| **L0 无账号** | 什么都不给 | 主站通知公告、教务部公告 | 直接 GET，无登录 | 部分可用，见 §2.4 |
| **L1 校园账号** | 统一身份认证登录（学号+密码，或企业微信扫码） | 公文通全部通知：体测、期末、讲座、开放日、报名 | CAS 会话 Cookie + 抓列表/详情 | 全站 CAS，必须登录 |
| **L2 教务/课表** | L1 之上，进入办事大厅对应应用 | 个人课表、考试安排、成绩 | eHall 应用页（需 appId）+ 会话 | 外壳公开，数据接口要会话 |
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

- `200`，是金智 amp 门户的 SPA 外壳，公开可加载
- 页面只挂了 jquery / i18n / `portal/js`，**应用列表和数据都在接口后面**，未登录拿不到
- 应用入口形态：`/appShow?appId=<数字>`；appId 必须先登录后从门户首页枚举，无法盲猜
- 所以「课表、创新领航讲座」这类要等拿到会话再做一次应用枚举

### 2.4 公开可用的部分

| 地址 | 状态 | 说明 |
|---|---|---|
| `https://www.szu.edu.cn/` | 200 | 主站，无 CAS |
| `https://www.szu.edu.cn/index/tzgg.htm` | 200 | 通知公告页，但列表是 JS 渲染，HTML 里没有条目，需抓 XHR 或换渲染方案 |
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
# 1. 浏览器登录公文通，F12 → Network → 复制 Cookie 整行
# 2. 批量抓，输出 data/board/notices-YYYYMMDD.json
npm run collect:board -- --cookie "<cookie>" --pages 5

# 3. 登录状态下入库（scope=school，按 source_url 去重）
curl -X POST http://localhost:3000/api/board/ingest \
     -H "Content-Type: application/json" -d @data/board/notices-20261108.json
```

调试用参数：`--save-raw` 存原始 HTML 到 `data/board/raw/`，`--from-html <file>` 离线验证解析，`--dry-run` 不落盘。

## 五、还没做完 / 待确认

- [ ] 公文通真实列表页的选择器需要用一份真实 HTML 校准（当前按特征匹配，能跑但可能漏条目）
- [ ] 详情页正文容器 `parseDetail` 的 `class` 匹配是猜的，需实页验证
- [ ] eHall 应用枚举（登录后）→ 课表 appId
- [ ] 创新领航讲座：确认是在公文通发通知，还是独立站点
