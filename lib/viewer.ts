import type { Profile } from "./types";

/**
 * 观看者身份。
 * 仅用于"判断一条数据能否被这个人看到"，不承担登录/鉴权——真正的边界仍应由 RLS 兜底。
 */
export type UserRole = "student" | "external" | "staff" | "alumni" | "unknown";

export interface ViewerUser {
  kind: "user";
  uid: string;
  role: UserRole;
  /** 是否已通过统一身份认证（有学号视为通过） */
  verified: boolean;
  studentNo?: string;
  college?: string;
  major?: string;
  grade?: string;
  class?: string;
  level?: string;
  courses: string[];
}

export interface ViewerAnon {
  kind: "anon";
}

export type Viewer = ViewerAnon | ViewerUser;

export const ANON: Viewer = { kind: "anon" };

/** 学号邮箱：2024150106@mails.szu.edu.cn */
const STUDENT_NO_IN_EMAIL = /^(\d{8,12})@/;

export function studentNoFromEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const m = STUDENT_NO_IN_EMAIL.exec(email.trim().toLowerCase());
  return m ? m[1] : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 从登录会话构造 Viewer。
 * 只有在拿不到 user.id 时才视为游客——其余情况宁可当作"未完善画像的校内用户"。
 */
export function toViewer(session: any, profile?: Profile | null): Viewer {
  const uid = session?.user?.id;
  if (!uid) return ANON;

  const email: string | undefined = session?.user?.email;
  const studentNo =
    studentNoFromEmail(email) ||
    (typeof session?.user?.user_metadata?.student_no === "string"
      ? session.user.user_metadata.student_no
      : undefined);

  return {
    kind: "user",
    uid: String(uid),
    role: studentNo ? "student" : "unknown",
    verified: Boolean(studentNo),
    studentNo,
    college: profile?.college?.trim() || undefined,
    major: profile?.major?.trim() || undefined,
    grade: profile?.grade?.trim() || undefined,
    class: undefined,
    level: profile?.level?.trim() || undefined,
    courses: profile?.courses ?? [],
  };
}

/**
 * 后续接入学号-学院映射表时在这里补全（B3）。
 * 现在：优先用映射表结果，查不到回退画像手填值，两者都没有就留空。
 */
export function resolveViewer(
  session: any,
  profile?: Profile | null,
  roster?: { college?: string; major?: string; class?: string; grade?: string } | null
): Viewer {
  const base = toViewer(session, profile);
  if (base.kind === "anon" || !roster) return base;
  return {
    ...base,
    college: roster.college || base.college,
    major: roster.major || base.major,
    class: roster.class || base.class,
    grade: roster.grade || base.grade,
  };
}

/** 供调试与日志使用，不含敏感字段 */
export function describeViewer(v: Viewer): string {
  if (v.kind === "anon") return "游客";
  const bits = [v.college, v.major, v.grade].filter(Boolean).join(" / ");
  return bits ? `${v.role}(${bits})` : v.role;
}
