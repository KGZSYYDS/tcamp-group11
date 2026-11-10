import type { Audience, Visibility } from "./types";
import type { Viewer } from "./viewer";

/**
 * 可见性判定：唯一入口。
 *
 * 设计原则
 * 1. 默认拒绝——未知的 visibility 一律不可见（历史代码里"未知就放行"是反的）。
 * 2. 判不准时往窄里落——getVisibilityFromAudience 永远不会自动产出 public。
 * 3. 这里只做"该不该给这个人看"，不做排序、不做展示，UI 只是调用方。
 */

export const VISIBILITY_VALUES: readonly Visibility[] = [
  "public",
  "campus",
  "college",
  "major",
  "grade",
  "class",
  "course",
  "private",
];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: "任何人可见",
  campus: "全校师生",
  college: "指定学院",
  major: "指定专业",
  grade: "指定年级",
  class: "指定班级",
  course: "选课学生",
  private: "仅自己",
};

/** 兼容 CalEvent、数据库行、以及管道里的草稿 */
export interface VisibilitySubject {
  visibility?: string | null;
  scope?: string | null;
  audience?: Audience | null;
  college?: string | null;
  grade?: string | number | null;
  ownerId?: string | null;
  owner_id?: string | null;
}

export function isVisibility(value: unknown): value is Visibility {
  return typeof value === "string" && (VISIBILITY_VALUES as readonly string[]).includes(value);
}

/** 旧 scope → 新模型。保留双读，是为了在数据库加列之前代码就能跑。 */
const LEGACY_SCOPE: Record<string, { visibility: Visibility; level?: string }> = {
  personal: { visibility: "private" },
  school: { visibility: "campus" },
  college: { visibility: "college" },
  grade: { visibility: "grade" },
  undergraduate: { visibility: "campus", level: "undergraduate" },
  postgraduate: { visibility: "campus", level: "postgraduate" },
  doctoral: { visibility: "campus", level: "doctoral" },
};

export interface ResolvedVisibility {
  visibility: Visibility;
  audience: Audience;
  /** 来源：新列 / 旧 scope / 兜底。便于排查历史数据 */
  from: "column" | "legacy" | "fallback";
}

/**
 * 把任意一条记录归一化成 {visibility, audience}。
 *
 * - 有 visibility 列 → 直接用它，audience 取列值
 * - 只有旧 scope → 按 LEGACY_SCOPE 映射，并把 college/grade 塞进 audience
 * - scope 缺失 → campus（历史数据默认是全校可见，保持行为不变）
 * - scope 是没见过的值 → private（宁可窄；同时 from 标记为 legacy 便于排查）
 */
export function pickVisibility(subject: VisibilitySubject): ResolvedVisibility {
  const column = subject.visibility;
  if (isVisibility(column)) {
    return { visibility: column, audience: normalizeAudience(subject.audience), from: "column" };
  }

  // 明确写了 visibility 但取值不认识 —— 不能当成"没填"放行，按最窄处理
  if (typeof column === "string" && column.trim()) {
    return { visibility: "private", audience: normalizeAudience(subject.audience), from: "fallback" };
  }

  const scope = (subject.scope || "").trim();
  if (!scope) {
    return { visibility: "campus", audience: normalizeAudience(subject.audience), from: "fallback" };
  }

  const mapped = LEGACY_SCOPE[scope];
  if (!mapped) {
    return { visibility: "private", audience: normalizeAudience(subject.audience), from: "legacy" };
  }

  const audience = normalizeAudience(subject.audience);
  if (mapped.visibility === "college" && !audience.college && subject.college) {
    audience.college = subject.college;
  }
  if (!audience.grade && subject.grade !== undefined && subject.grade !== null) {
    audience.grade = subject.grade;
  }
  if (mapped.level) audience.level = audience.level || mapped.level;

  return { visibility: mapped.visibility, audience, from: "legacy" };
}

function normalizeAudience(audience?: Audience | null): Audience {
  if (!audience || typeof audience !== "object") return {};
  const out: Audience = {};
  if (audience.college) out.college = String(audience.college).trim();
  if (audience.major) out.major = String(audience.major).trim();
  if (audience.class) out.class = String(audience.class).trim();
  if (audience.level) out.level = String(audience.level).trim();
  if (audience.course) out.course = String(audience.course).trim();
  if (audience.grade !== undefined && audience.grade !== null && audience.grade !== "") {
    out.grade = audience.grade;
  }
  return out;
}

/**
 * 从受众推导可见级别。用于抽取后的兜底：
 * 没有明确依据时落到 campus，**永远不会自动产出 public**——公开是需要人工确认的动作。
 */
export function getVisibilityFromAudience(audience: Audience): Visibility {
  if (audience.class) return "class";
  if (audience.course) return "course";
  if (audience.major) return "major";
  if (audience.college) return "college";
  if (audience.grade !== undefined && audience.grade !== "") return "grade";
  return "campus";
}

/* ---------- 判定 ---------- */

const FULL_WIDTH_OFFSET = 0xfee0;

/** 比较前统一：去空白、全角转半角、大小写不敏感 */
export function sameText(a?: string | number | null, b?: string | number | null): boolean {
  const norm = (v?: string | number | null) =>
    String(v ?? "")
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET))
      .replace(/\s+/g, "")
      .trim()
      .toLowerCase();
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}

/**
 * 这条内容能不能给这个观看者看。
 * 拿不到对方的归属属性时（例如没填学院）按"无法证明 → 不给看"处理，避免越权。
 */
export function isVisible(subject: VisibilitySubject, viewer: Viewer): boolean {
  const { visibility, audience } = pickVisibility(subject);

  if (visibility === "public") return true;
  if (viewer.kind === "anon") return false;

  switch (visibility) {
    case "campus":
      // level 限定（本科/硕士/博士）只对已声明 level 的用户生效；
      // 未填画像的用户仍能看到 campus 级内容，否则新用户会看到空白日历。
      return !audience.level || !viewer.level || sameText(audience.level, viewer.level);

    case "private":
      return sameText(ownerOf(subject), viewer.uid);

    case "college":
      return sameText(audience.college, viewer.college);

    case "major":
      return sameText(audience.major, viewer.major);

    case "grade":
      return sameText(audience.grade, viewer.grade);

    case "class":
      return sameText(audience.class, viewer.class);

    case "course":
      return (viewer.courses || []).some((c) => sameText(c, audience.course));

    default:
      return false;
  }
}

function ownerOf(subject: VisibilitySubject): string | undefined {
  return subject.ownerId ?? subject.owner_id ?? undefined;
}

/** UI 徽标文案 */
export function describeVisibility(subject: VisibilitySubject): string {
  const { visibility, audience } = pickVisibility(subject);
  switch (visibility) {
    case "college":
      return audience.college ? `${audience.college}` : "指定学院";
    case "major":
      return audience.major ? `${audience.major}` : "指定专业";
    case "grade":
      return audience.grade ? `${audience.grade} 级` : "指定年级";
    case "class":
      return audience.class ? `${audience.class}` : "指定班级";
    case "course":
      return audience.course ? `${audience.course}` : "选课学生";
    default:
      return VISIBILITY_LABEL[visibility];
  }
}
