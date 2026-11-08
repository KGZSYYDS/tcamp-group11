"use client";

import { useEffect, useState } from "react";
import { cloud } from "@/lib/cloud";
import { getProfile, saveProfile } from "@/lib/data";

interface Props {
  session: {
    user?: { id?: string; name?: string; phone?: string; email?: string };
  };
}

export default function ProfilePanel({ session }: Props) {
  const [college, setCollege] = useState("");
  const [major, setMajor] = useState("");
  const [grade, setGrade] = useState("");
  const [level, setLevel] = useState("undergraduate");
  const [coursesText, setCoursesText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    getProfile()
      .then((p) => {
        if (p) {
          setCollege(p.college || "");
          setMajor(p.major || "");
          setGrade(p.grade || "");
          setLevel(p.level || "undergraduate");
          setCoursesText(p.courses.join("\n"));
        }
        setLoaded(true);
      })
      .catch((e) => {
        setError(e.message);
        setLoaded(true);
      });
  }, []);

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

  const user = session.user || {};

  return (
    <div className="grid gap-4 sm:grid-cols-5">
      <form onSubmit={save} className="rounded-xl bg-white p-5 shadow-sm sm:col-span-3">
        <h2 className="mb-1 font-medium">个人画像</h2>
        <p className="mb-4 text-xs text-gray-400">
          用于「只看与我相关」：全校事件人人可见，学院 / 年级事件按画像匹配。仅自己可见。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">学院</span>
            <input
              value={college}
              onChange={(e) => setCollege(e.target.value)}
              placeholder="如：计算机与软件学院"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">专业</span>
            <input
              value={major}
              onChange={(e) => setMajor(e.target.value)}
              placeholder="如：计算机科学与技术"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">年级</span>
            <input
              list="grade-list"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="如：2026 级"
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
        <h2 className="mb-4 font-medium">账号</h2>
        <div className="space-y-2 text-sm text-gray-600">
          {user.name && <p>昵称：{user.name}</p>}
          {user.phone && <p>手机号：{user.phone}</p>}
          {user.email && <p>邮箱：{user.email}</p>}
        </div>
        <button
          onClick={() => cloud.auth.signOut()}
          className="mt-6 w-full rounded-lg border border-gray-200 py-2 text-sm text-gray-500 hover:bg-gray-50 hover:text-red-500"
        >
          退出登录
        </button>
        <p className="mt-4 text-xs text-gray-400">
          数据保存在云端，换设备登录同一账号即可同步。
        </p>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm sm:col-span-5">
        <h2 className="mb-1 font-medium">同步助手插件</h2>
        <p className="mb-3 text-xs text-gray-400">
          安装后自动同步畅课作业、定时采集公文通通知，采集到的公共事件共享给全校同学。
        </p>
        <a
          href="/szu-calendar-sync.zip"
          download
          className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          下载插件（Chrome / Edge）
        </a>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-gray-500">
          <li>解压 zip 到一个固定文件夹（不要解压后删除）</li>
          <li>浏览器地址栏输入 chrome://extensions，打开右上角「开发者模式」</li>
          <li>点「加载已解压的扩展程序」，选中解压出的文件夹</li>
          <li>登录畅课 / 内部网浏览，点插件图标即可同步</li>
        </ol>
      </div>
    </div>
  );
}
