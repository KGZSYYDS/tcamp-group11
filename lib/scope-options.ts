import type { Audience, Visibility } from "./types";

/**
 * 可见范围选项的唯一来源。
 *
 * 目前代码里有三处各自维护一套（手动建档 4 项、AI 导入 7 项、插件同步 7 项），
 * 导致同一条数据在不同入口能选到的范围不一致。以后所有下拉都从这里取。
 */

export interface ScopeOption {
  /** 旧 scope 取值，仍作为写入数据库的值（新列上线前保持兼容） */
  value: string;
  label: string;
  visibility: Visibility;
  hint: string;
}

export const SCOPE_OPTIONS: ScopeOption[] = [
  { value: "personal", label: "仅自己", visibility: "private", hint: "只有你本人能看到" },
  { value: "school", label: "全校", visibility: "campus", hint: "所有登录用户可见" },
  { value: "college", label: "指定学院", visibility: "college", hint: "需要填写学院名称" },
  { value: "grade", label: "指定年级", visibility: "grade", hint: "需要填写年级，如 2024" },
  { value: "undergraduate", label: "本科生", visibility: "campus", hint: "仅本科生可见" },
  { value: "postgraduate", label: "硕士生", visibility: "campus", hint: "仅硕士生可见" },
  { value: "doctoral", label: "博士生", visibility: "campus", hint: "仅博士生可见" },
];

export const SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  SCOPE_OPTIONS.map((o) => [o.value, o.label])
);

export const SCOPE_VALUES: string[] = SCOPE_OPTIONS.map((o) => o.value);

/** 该 scope 是否需要额外填写归属字段 */
export function scopeNeeds(scope: string): "college" | "grade" | null {
  if (scope === "college") return "college";
  if (scope === "grade") return "grade";
  return null;
}

/** 反向：从可见性模型推回表单可用的 scope（新列上线后表单仍写 scope） */
export function scopeFromVisibility(visibility: Visibility, audience?: Audience): string {
  switch (visibility) {
    case "private":
      return "personal";
    case "campus":
      if (audience?.level === "undergraduate") return "undergraduate";
      if (audience?.level === "postgraduate") return "postgraduate";
      if (audience?.level === "doctoral") return "doctoral";
      return "school";
    case "college":
      return "college";
    case "grade":
      return "grade";
    default:
      // class / course / major 暂时没有对应的旧 scope，最接近的是指定学院
      return "college";
  }
}
