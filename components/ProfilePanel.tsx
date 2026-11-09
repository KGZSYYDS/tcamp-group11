"use client";

import { useEffect, useRef, useState } from "react";
import { getProfile, saveProfile } from "@/lib/data";
import type { SzUser } from "@/lib/szu-types";
import LoginPanel from "@/components/LoginPanel";
import WeChatImporter from "@/components/WeChatImporter";
import {
  clearPersonal,
  clearTimetable,
  importFile,
  loadPersonal,
  loadTimetable,
  summarize,
  type LocalPersonal,
  type LocalTimetable,
} from "@/lib/local-store";

interface Props {
  /** 未登录时为 null —— 本页一半功能（画像、导入）照样可用 */
  session: SzUser | null;
  /** 登录成功后让外层重新查一次登录态 */
  onSignedIn: () => void;
  /** 登出后让外层重新查一次登录态 */
  onSignOut: () => void;
}

const LEVEL_LABEL: Record<string, string> = {
  undergraduate: "本科生",
  postgraduate: "硕士生",
  doctoral: "博士生",
};

export default function ProfilePanel({ session, onSignedIn, onSignOut }: Props) {
  const [college, setCollege] = useState("");
  const [major, setMajor] = useState("");
  const [grade, setGrade] = useState("");
  const [level, setLevel] = useState("undergraduate");
  const [coursesText, setCoursesText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const [local, setLocal] = useState<LocalTimetable | null>(null);
  const [personal, setPersonal] = useState<LocalPersonal | null>(null);
  const [importMsg, setImportMsg] = useState("");
  const [importErr, setImportErr] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncErr, setSyncErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 导入过课表就别让「读云端画像」的异步结果把新值盖回去 */
  const touched = useRef(false);

  useEffect(() => {
    const t = loadTimetable();
    setLocal(t);
    setPersonal(loadPersonal());

    // 登录时同步下来的课表自带学籍档案，比云端画像新，优先用它
    const p = t?.profile;
    if (p) {
      const merged = {
        college: p.college || "",
        major: p.major || "",
        grade: p.grade || "",
        level: p.level || "undergraduate",
        courses: t?.courses || [],
      };
      touched.current = true;
      setCollege(merged.college);
      setMajor(merged.major);
      setGrade(merged.grade);
      setLevel(merged.level);
      setCoursesText(merged.courses.join("\n"));
      setLoaded(true);
      // 顺手把画像回写云端：日历的学院/年级过滤读的是这张表
      saveProfile(merged).catch(() => {});
      return;
    }

    getProfile()
      .then((p) => {
        if (p && !touched.current) {
          setCollege(p.college || "");
          setMajor(p.major || "");
          setGrade(p.grade || "");
          setLevel(p.level || "undergraduate");
          setCoursesText(p.courses.join("\n"));
        }
        setLoaded(true);
      })
      .catch((e) => {
        // 游客态读云端画像可能被权限挡住，这不是用户要处理的错误 —— 手填就行
        if (session) setError(e.message);
        setLoaded(true);
      });
  }, []);

  /** 把一份课表落到本机 + 画像，导入与重新同步共用 */
  async function applyTimetable(t: LocalTimetable) {
    setLocal(t);
    if (!t.profile) return;
    const merged = {
      college: t.profile.college || college,
      major: t.profile.major || major,
      grade: t.profile.grade || grade,
      level: t.profile.level || level,
      courses: t.courses?.length
        ? t.courses
        : coursesText
            .split(/[\n,，;；]/)
            .map((c) => c.trim())
            .filter(Boolean),
    };
    touched.current = true;
    setCollege(merged.college);
    setMajor(merged.major);
    setGrade(merged.grade);
    setLevel(merged.level);
    setCoursesText(merged.courses.join("\n"));
    try {
      await saveProfile(merged);
    } catch {
      // 画像写云端失败不影响课表本身
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    setError("");
    try {
      await saveProfile({
        college,
        major,
        grade,
        level,
        courses: coursesText
          .split(/[\n,，;；]/)
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setMsg("画像已保存，日历将按你的信息匹配公共事件");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
    setSaving(false);
  }

  /** 导入本机脚本生成的文件：课表或群聊排出的待办，都只进浏览器本地，不上云 */
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg("");
    setImportErr("");
    try {
      const text = await file.text();
      const r = importFile(text, file.name);

      if (r.type === "personal") {
        setPersonal(r.data);
        setImportMsg(
          `已导入 ${r.data.events.length} 条事项（本次新增 ${r.merged} 条，累计 ${r.total} 条），` +
            `会议与截止时间会出现在日历上`
        );
        return;
      }

      await applyTimetable(r.data);
      const s = summarize(r.data);
      setImportMsg(
        `已导入 ${s.term}：${s.courses} 门课 / ${s.sessions} 节（${s.from} ~ ${s.to}）` +
          (r.data.profile?.college ? `，学院「${r.data.profile.college}」已自动带入画像` : "")
      );
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "导入失败");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** 用本机保存的学校会话重新拉一次课表；会话过期会要求重新登录 */
  async function resync() {
    setSyncing(true);
    setSyncMsg("");
    setSyncErr("");
    try {
      const res = await fetch("/api/szu/timetable", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setSyncErr(data.message || `同步失败（HTTP ${res.status}）`);
        return;
      }
      const r = importFile(JSON.stringify(data.timetable), "重新同步");
      if (r.type === "timetable") {
        await applyTimetable(r.data);
        const s = summarize(r.data);
        setSyncMsg(
          `已同步 ${s.term}：${s.courses} 门课 / ${s.sessions} 节（${s.from} ~ ${s.to}）`
        );
      }
    } catch (err) {
      setSyncErr(err instanceof Error ? err.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  /** 登录卡成功：课表已落本机，重读一遍让统计与画像跟上，再刷新外层登录态 */
  async function handleSignedIn() {
    const t = loadTimetable();
    if (t) await applyTimetable(t);
    else setLocal(null);
    setImportMsg(t ? "课表已同步到本机" : "");
    onSignedIn();
  }

  async function signOut() {
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    onSignOut();
  }

  function removeLocal() {
    clearTimetable();
    setLocal(null);
    setImportMsg("已移除本机课表（云端数据不受影响）");
  }

  function removePersonal() {
    clearPersonal();
    setPersonal(null);
    setImportMsg("已移除本机待办");
  }

  const localStat = local ? summarize(local) : null;
  const personalStat = personal
    ? {
        meetings: personal.events.filter((e) => e.kind === "meeting").length,
        deadlines: personal.events.filter((e) => e.kind === "deadline").length,
        from: personal.events.map((e) => e.startAt.slice(0, 10)).sort()[0] || "",
        to: personal.events.map((e) => e.startAt.slice(0, 10)).sort().pop() || "",
      }
    : null;

  return (
    <div className="grid gap-4 sm:grid-cols-5">
      <form onSubmit={save} className="rounded-xl bg-white p-5 shadow-sm sm:col-span-3">
        <h2 className="mb-1 font-medium">个人画像</h2>
        <p className="mb-4 text-xs text-gray-400">
          用于「只看与我相关」：全校事件人人可见，学院 / 年级事件按画像匹配。仅自己可见。
          <br />
          {session
            ? "登录时已从学籍系统自动取回，下面的值可以直接改。"
            : "没登录也能填，填完「只看与我相关」就会按学院 / 年级过滤。"}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">学院</span>
            <input
              value={college}
              onChange={(e) => setCollege(e.target.value)}
              placeholder="如 计算机与软件学院"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">专业</span>
            <input
              value={major}
              onChange={(e) => setMajor(e.target.value)}
              placeholder="教务没给时可手填"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">年级</span>
            <input
              list="grade-list"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="如 2026 级"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
            <datalist id="grade-list">
              {["2023 级", "2024 级", "2025 级", "2026 级"].map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">培养层次</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
            >
              <option value="undergraduate">本科生</option>
              <option value="postgraduate">硕士生</option>
              <option value="doctoral">博士生</option>
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-gray-600">本学期课程（每行一门）</span>
            <textarea
              value={coursesText}
              onChange={(e) => setCoursesText(e.target.value)}
              rows={4}
              placeholder={"计算机导论\n程序设计基础\n线性代数"}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={saving || !loaded}
          className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存画像"}
        </button>
        {msg && <p className="mt-2 text-xs text-emerald-600">{msg}</p>}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </form>

      <div className="rounded-xl bg-white p-5 shadow-sm sm:col-span-2">
        {session ? (
          <>
            <h2 className="mb-4 font-medium">账号</h2>
            <div className="space-y-2 text-sm text-gray-600">
              {session.name && <p>姓名：{session.name}</p>}
              <p>学号：{session.studentId}</p>
              {session.college && <p>学院：{session.college}</p>}
              {session.major && <p>专业：{session.major}</p>}
              {session.grade && <p>年级：{session.grade}</p>}
              <p>层次：{LEVEL_LABEL[session.level] || session.level}</p>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              统一认证登录，本机免登录 7 天。密码没有保存，课表存在这台设备的浏览器里。
            </p>
          </>
        ) : (
          <LoginPanel onLoggedIn={handleSignedIn} />
        )}

        <div className="mt-5 border-t border-gray-100 pt-4">
          <h3 className="mb-1 text-sm font-medium text-gray-700">课表</h3>
          <p className="mb-2 text-xs text-gray-400">
            {session
              ? "课表存在这台设备的浏览器里，不上传云端。换了课或者到了新学期，点下面重新取一次。"
              : "已经用命令行导出过课表？直接导入文件即可，效果和登录同步一样，不需要密码。"}
          </p>

          {session && (
            <button
              type="button"
              onClick={resync}
              disabled={syncing}
              className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {syncing ? "正在读取…" : "重新同步课表"}
            </button>
          )}
          {syncMsg && <p className="mt-2 text-xs text-emerald-600">{syncMsg}</p>}
          {syncErr && <p className="mt-2 text-xs text-red-500">{syncErr}</p>}

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={onPickFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="mt-2 w-full rounded-lg border border-gray-200 py-2 text-sm text-gray-500 hover:bg-gray-50"
          >
            从文件导入
          </button>
          <p className="mt-1 text-center text-[11px] text-gray-400">
            timetable-*.json（课表）· meetings-*.json（群聊待办）
          </p>

          {localStat && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <p className="font-medium text-gray-700">{localStat.term}</p>
              <p className="mt-1">
                {localStat.courses} 门课 · {localStat.sessions} 节
              </p>
              <p className="text-gray-400">
                {localStat.from} ~ {localStat.to}
              </p>
              {local?.courses?.length ? (
                <p className="mt-2 leading-relaxed text-gray-500">{local.courses.join("、")}</p>
              ) : null}
              <button
                type="button"
                onClick={removeLocal}
                className="mt-3 rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:text-red-500"
              >
                移除本机课表
              </button>
            </div>
          )}

          {personalStat && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <p className="font-medium text-gray-700">群聊待办</p>
              <p className="mt-1">
                {personalStat.meetings} 场会议 · {personalStat.deadlines} 个截止
              </p>
              <p className="text-gray-400">
                {personalStat.from} ~ {personalStat.to}
              </p>
              <button
                type="button"
                onClick={removePersonal}
                className="mt-3 rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:text-red-500"
              >
                移除本机待办
              </button>
            </div>
          )}

          {importMsg && <p className="mt-2 text-xs text-emerald-600">{importMsg}</p>}
          {importErr && <p className="mt-2 text-xs text-red-500">{importErr}</p>}
        </div>

        {session && (
          <button
            onClick={signOut}
            className="mt-6 w-full rounded-lg border border-gray-200 py-2 text-sm text-gray-500 hover:bg-gray-50 hover:text-red-500"
          >
            退出登录
          </button>
        )}
      </div>

      <WeChatImporter
        onImported={(items, addedCount) => {
          setPersonal(loadPersonal());
          setImportMsg(
            addedCount > 0
              ? `从聊天记录里提出 ${items.length} 条，本机新增 ${addedCount} 条`
              : `提出 ${items.length} 条，都是已存在的，没有重复写入`
          );
        }}
      />

      <div className="rounded-xl bg-white p-5 shadow-sm sm:col-span-2">
        <h2 className="mb-1 font-medium">命令行采集（可选）</h2>
        <p className="mb-3 text-xs text-gray-400">
          只为批量任务保留：批量抓公文通与官网、全量扫微信群。
          与网页共用同一份会话缓存，网页登录过之后命令行不用再输密码。
        </p>
        <ol className="space-y-2 text-xs text-gray-600">
          <li>
            <code className="rounded bg-gray-100 px-1 py-0.5">npm run collect:web</code>
            <span className="ml-2 text-gray-400">官网公告 / 学术动态（免登录）</span>
          </li>
          <li>
            <code className="rounded bg-gray-100 px-1 py-0.5">npm run collect:board</code>
            <span className="ml-2 text-gray-400">公文通通知（要登录）</span>
          </li>
          <li>
            <code className="rounded bg-gray-100 px-1 py-0.5">npm run ingest:notices</code>
            <span className="ml-2 text-gray-400">抽时间与截止，写公共库</span>
          </li>
          <li>
            <code className="rounded bg-gray-100 px-1 py-0.5">npm run meetings:all</code>
            <span className="ml-2 text-gray-400">扫全部群，模型抽取后导入</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
