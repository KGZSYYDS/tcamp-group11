export const BOARD_GROUPS = [
  { id: "teaching", route: "教务", label: "教务教学", subtypes: {
    course_selection: "选课", schedule_exam: "排课排考", academic_status: "学籍学位", academic_competition: "学科竞赛",
    thesis_defense: "毕业答辩", internship_training: "实习实训", admissions: "招生工作",
  } },
  { id: "research", route: "科研", label: "科研动态", subtypes: {
    project_initiation: "科研立项", proposal: "课题申报", paper: "学术论文", patent_publication: "专利著作", awards: "获奖成果",
  } },
  { id: "administration", route: "行政", label: "党务行政", subtypes: {
    party_government: "党政事务", organization: "组织统战", publicity: "宣传", supervision: "纪检监察",
    personnel: "人事", external_affairs: "外事", equipment: "设备", finance_audit: "财务审计",
  } },
  { id: "students", route: "学工", label: "学生工作", subtypes: {
    financial_aid: "奖学助贷", mental_health: "心理健康", employment: "创业就业",
    residence: "住宿管理", youth_league: "团委", student_clubs: "学生会和社团",
  } },
  { id: "lectures", route: "讲座", label: "学术讲座", subtypes: {
    guest_lecture: "名师讲座", expert_forum: "专家论坛", academic_report: "学术报告", seminar: "专题研讨",
  } },
  { id: "campus_life", route: "生活", label: "校园生活", subtypes: {
    culture_sports: "文化体育", staff_union: "工会活动", logistics: "后勤服务", utilities: "餐饮水电",
    environment: "环境绿化", safety_transport: "安保交通", networking: "网络信息化",
  } },
];

export function boardGroup(value) {
  return BOARD_GROUPS.find((group) => [group.id, group.route, group.label].includes(value));
}

export function boardNoticeId(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const id = url.searchParams.get("id");
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname === "www1.szu.edu.cn" &&
        url.pathname.toLowerCase() === "/board/view.asp" && id && /^\d+$/.test(id)) return id;
  } catch {
    return undefined;
  }
}

// 旧通知尚无模型标签时，只采纳标题里直接命中的栏目内词汇。
const SUBTYPE_TITLE = {
  teaching: {
    course_selection: /选退课|退补选|选课|补选/,
    schedule_exam: /排课|排考|考试安排|调停课|停课|调课|补考|缓考|线下见面课/,
    academic_status: /学籍|转专业|开题报告|学位授予|学位资格|辅修学士学位/,
    academic_competition: /学科竞赛|数学建模竞赛|程序设计竞赛/,
    thesis_defense: /答辩/,
    internship_training: /实习实训|认识实习|生产实习|实践教学/,
    admissions: /招生|招收.*(?:硕士|博士|研究生)|研招|推免生/,
  },
  research: {
    project_initiation: /立项名单|立项结果|获批立项|项目立项公示/,
    proposal: /课题申报|申报.*(?:课题|项目|基金)|(?:课题|项目|基金).*申报/,
    paper: /发表论文|论文发表|期刊发表|在.{1,25}发表/,
    patent_publication: /发明专利|专利转让|专利许可|学术著作/,
    awards: /获奖成果|获奖名单|科研成果获奖|荣获.*(?:科学技术奖|科研奖)/,
  },
  administration: {
    party_government: /党政联席|行政办公会|校长办公会|党委常委会/,
    organization: /组织统战|统战工作|党校|发展对象|党员发展/,
    publicity: /新闻宣传|宣传工作|宣传报道/,
    supervision: /纪检监察|纪律检查|巡视巡察|廉政教育/,
    personnel: /人事|离退休|退休人员|职称评审|岗位聘任|人才招聘/,
    external_affairs: /因公出国|外事管理|出访公示|外事工作/,
    equipment: /设备采购|仪器设备|设备报废|设备维修/,
    finance_audit: /财务|审计|学分学费|银行批扣|报销/,
  },
  students: {
    financial_aid: /奖学金|助学金|助学贷款|经济困难|资助工作/,
    mental_health: /心理健康|心理咨询|心理辅导/,
    employment: /创业|就业|招聘|双选会|宣讲会|访企拓岗|职业规划|实习岗位/,
    residence: /宿舍|住宿|退宿/,
    youth_league: /团委|团支部|共青团|青马工程|青马先锋团/,
    student_clubs: /学生会|学生社团|社团招新|社团活动/,
  },
  lectures: {
    guest_lecture: /名师讲座|院士讲课|名师进中学/,
    expert_forum: /专家论坛|学术论坛|论坛议程/,
    academic_report: /学术报告|报告会|colloquium/i,
    seminar: /专题研讨|研讨会|圆桌研讨/,
  },
  campus_life: {
    culture_sports: /文化体育|运动会|体育竞赛|读书会|音乐会|校园艺术/,
    staff_union: /工会/,
    logistics: /后勤服务|物业服务|楼宇维修/,
    utilities: /停水|停电|供水|供电|食堂|餐饮/,
    environment: /环境绿化|绿化养护|树木修剪/,
    safety_transport: /通行管制|交通管制|校园交通|消防|安全保卫|安保/,
    networking: /网络信息化|校园网|服务器升级|信息系统升级/,
  },
};

export function inferBoardSubtype(group, title) {
  const matches = Object.entries(SUBTYPE_TITLE[group.id] || {})
    .filter(([code, pattern]) => Object.hasOwn(group.subtypes, code) && pattern.test(title));
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function mergeBoardListing(previous, incoming, route) {
  const fromRoute = boardGroup(route);
  const fromRow = boardGroup(incoming.category);
  const primary = boardGroup(previous?.boardGroup) || fromRow || fromRoute;
  const ids = new Set([...(previous?.boardGroups || []), ...(incoming.boardGroups || []), primary?.id, fromRow?.id, fromRoute?.id]);
  const groups = BOARD_GROUPS.filter(({ id }) => ids.has(id)).map(({ id }) => id);
  return {
    ...previous,
    ...incoming,
    category: primary?.route || incoming.category || previous?.category || null,
    boardGroup: primary?.id,
    boardGroups: groups,
    pinned: Boolean(previous?.pinned || incoming.pinned || route === "置顶"),
  };
}

// Keep classification in a dedicated first line of note until a typed database column is available.
const MARKER = /^\[board-taxonomy-v1:([a-z_]+):([a-z_]+|-)\](?:\r?\n|$)/;

export function readBoardMetadata(note) {
  const match = note?.match(MARKER);
  const original = match ? note.slice(match[0].length) || undefined : note;
  const group = boardGroup(match?.[1]) || boardGroup(original?.match(/(?:^|｜)栏目：([^｜\r\n]+)/)?.[1]?.trim());
  const subtype = group && match && Object.hasOwn(group.subtypes, match[2]) ? match[2] : undefined;
  return { group, subtype, classified: Boolean(group && match && (subtype || match[2] === "review")), note: original };
}

export function writeBoardMetadata(note, groupId, subtype) {
  const group = boardGroup(groupId);
  if (!group || (typeof subtype === "string" && !Object.hasOwn(group.subtypes, subtype))) {
    throw new Error("公文通栏目或小类不在官方词表中");
  }
  const original = readBoardMetadata(note ?? undefined).note;
  const code = subtype === null ? "review" : subtype ?? "-";
  return `[board-taxonomy-v1:${group.id}:${code}]${original ? "\n" + original : ""}`;
}
