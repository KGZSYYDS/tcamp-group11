// 畅课（lms.szu.edu.cn）精确解析器 v2
// 依据真实接口样本编写：
//   POST /api/my-courses           → courses[]（课程 + 教师）
//   GET  /api/todos                → todo_list[]（全站待办作业）
//   GET  /api/courses/:id/activities → activities[]（课程作业/在线考试）
//   GET  /api/courses/:id          → 课程详情（补充教师）
(function () {
  function iso(t) {
    if (!t) return null;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function courseNameOf(map, id) {
    const c = map.get(Number(id));
    return c ? c.name : null;
  }

  window.SzuCalParser = {
    parse(records) {
      const courseMap = new Map(); // id -> { name, instructors[] }
      const ddls = [];

      // 第一遍：建立课程映射（含教师）
      for (const r of records) {
        const path = r.url.split("?")[0];
        if (path.indexOf("/api/my-courses") !== -1 && Array.isArray(r.body.courses)) {
          for (const c of r.body.courses) {
            courseMap.set(Number(c.id), {
              name: c.name,
              instructors: (c.instructors || []).map((i) => i.name).filter(Boolean),
            });
          }
        }
        if (/^\/api\/courses\/\d+$/.test(path) && r.body && r.body.id && r.body.name) {
          courseMap.set(Number(r.body.id), {
            name: r.body.name,
            instructors: (r.body.instructors || []).map((i) => i.name).filter(Boolean),
          });
        }
      }

      // 第二遍：提取作业
      for (const r of records) {
        const path = r.url.split("?")[0];

        // 全站待办（最重要：不用逐门课打开也能拿到）
        if (path === "/api/todos" && Array.isArray(r.body.todo_list)) {
          for (const t of r.body.todo_list) {
            const dueAt = iso(t.end_time);
            if (!t.title || !dueAt) continue;
            ddls.push({
              course:
                t.course_name || courseNameOf(courseMap, t.course_id) || "未匹配课程",
              title: String(t.title).trim(),
              dueAt,
              note: "畅课自动同步",
            });
          }
        }

        // 单门课的活动列表（作业 / 在线考试）
        const actMatch = path.match(/^\/api\/courses\/(\d+)\/activities$/);
        if (actMatch && Array.isArray(r.body.activities)) {
          const cid = Number(actMatch[1]);
          for (const a of r.body.activities) {
            if (["homework", "exam", "quiz"].indexOf(a.type) === -1) continue;
            const dueAt = iso(a.end_time || a.deadline);
            if (!a.title || !dueAt) continue;
            ddls.push({
              course: courseNameOf(courseMap, cid) || "课程 " + cid,
              title: String(a.title).trim(),
              dueAt,
              note: "畅课自动同步",
            });
          }
        }
      }

      // 去重：课程 + 标题 + 截止时间
      const seen = new Set();
      const uniqueDdls = ddls.filter((d) => {
        const key = d.course + "|" + d.title + "|" + d.dueAt;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return {
        ddls: uniqueDdls,
        courses: Array.from(new Set(Array.from(courseMap.values()).map((c) => c.name))),
        notices: extractNotices(records),
      };
    },
  };

  // ---------- 公文通通知提取（启发式，待真实样本加固） ----------
  const NOTICE_TITLE_KEYS = ["title", "noticeTitle", "subject", "name"];
  const NOTICE_TIME_KEYS = [
    "publishTime", "publishDate", "publishedAt", "publish_time",
    "createTime", "created_at", "releaseTime", "date",
  ];
  const NOTICE_CONTENT_KEYS = [
    "content", "contentHtml", "noticeContent", "body", "html", "text", "detail",
  ];
  const NOTICE_DEPT_KEYS = [
    "department", "deptName", "source", "author",
    "publishDepartment", "unit", "orgName",
  ];

  function pickKey(obj, keys) {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
    }
    return undefined;
  }

  function walkNotice(node, out) {
    if (Array.isArray(node)) {
      for (const item of node) walkNotice(item, out);
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const title = pickKey(node, NOTICE_TITLE_KEYS);
    const content = pickKey(node, NOTICE_CONTENT_KEYS);
    if (
      typeof title === "string" &&
      title.length >= 4 &&
      title.length <= 150 &&
      typeof content === "string" &&
      content.length > 50
    ) {
      const time = pickKey(node, NOTICE_TIME_KEYS);
      const dept = pickKey(node, NOTICE_DEPT_KEYS);
      out.push({
        title: title.trim(),
        content,
        department: typeof dept === "string" ? dept : "",
        publishedAt: time ? String(time) : "",
        url: typeof node.url === "string" ? node.url : "",
      });
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === "object") walkNotice(child, out);
    }
  }

  function extractNotices(records) {
    const found = [];
    for (const r of records) {
      // 跳过畅课接口，避免把课程内容误当通知
      // （origin 由 content script 附带；旧数据无 origin 时按绝对 URL 判断）
      const source = r.origin || r.url;
      if (source.indexOf("lms.szu.edu.cn") !== -1) continue;
      walkNotice(r.body, found);
    }
    const seen = new Set();
    return found
      .filter((n) => {
        const key = n.title + "|" + n.publishedAt;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 20); // 单次最多 20 条，控制 AI 调用量
  }
})();
