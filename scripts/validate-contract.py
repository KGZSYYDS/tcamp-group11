#!/usr/bin/env python3
"""校验 examples/ 与 data/ 下的真实数据是否符合 docs/schema/ 里的 JSON Schema。

用法（项目根目录）:
    pip install jsonschema
    python scripts/validate-contract.py

退出码 0 = 全通过，1 = 有失败。改了 schema 或实体字段后跑一遍。

注意：$ref 指向 common.schema.json，必须先按 $id 把所有 schema 注册进
referencing.Registry 再校验；老写法 RefResolver 已废弃，会直接报错。
"""

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "docs" / "schema"
EX = ROOT / "examples"

# 样例 -> 用哪份 schema 校验。
#   file  : 相对项目根的路径（可以是 data/ 下的全量真数据，不限于 examples/）
#   schema: docs/schema 下的文件名
#   sub   : 取对象里的哪个键再校验（空 = 整个文件）
#   defn  : 取 schema 的 $defs 里的哪个子 schema（空 = 用 schema 本身）
CASES = [
    # --- 实体 ---
    dict(file="examples/app-events.json", schema="event.schema.json"),
    dict(file="examples/ddls-local.json", schema="ddl.schema.json"),
    dict(file="examples/checkins-local.json", schema="checkin.schema.json"),
    dict(file="examples/personal-items.json", schema="personal-item.schema.json"),
    dict(file="examples/ddls-lms.json", schema="ddl-input.schema.json", sub="items"),
    dict(file="examples/sync-payload.json", schema="sync-payload.schema.json"),
    # --- 文件 ---
    dict(file="examples/files/timetable-2026-2027-1.json", schema="timetable-file.schema.json"),
    dict(file="examples/files/personal-2026-11-08.json", schema="personal-file.schema.json"),
    dict(file="examples/files/profile.json", schema="profile.schema.json", unmask=True),
    # --- 接口 ---
    dict(file="examples/api/wechat-scan.json", schema="wechat-scan.schema.json", sub="request", defn="request"),
    dict(file="examples/api/wechat-scan.json", schema="wechat-scan.schema.json", sub="response", defn="response"),
    # --- 全量真数据（这才是最有价值的一遍：556 + 40 条通知逐条校验）---
    dict(file="data/board/notices-latest.json", schema="notice.schema.json"),
    dict(file="data/web/notices-web-latest.json", schema="notice.schema.json"),
]

# 只确认是合法 JSON、不套 schema 的（上游原始结构 / 接口包装形态）
JSON_ONLY = [
    "examples/cloud-events.json",
    "examples/sources/lms-todos-raw.json",
    "examples/sources/weflow-chatroom.json",
    "examples/sources/board-notice.json",
    "examples/files/meeting-sources.json",
    "examples/api/auth-szu.json",
    "examples/api/auth-session.json",
    "examples/api/lms-login.json",
    "examples/api/lms-status.json",
    "examples/api/wechat-status.json",
    "examples/api/wechat-groups.json",
    "examples/api/wechat-config.json",
    "examples/api/wechat-key.json",
    "examples/api/board-ingest.json",
]


def build_registry():
    registry = Registry()
    schemas = {}
    for p in SCHEMA_DIR.glob("*.schema.json"):
        doc = json.loads(p.read_text(encoding="utf-8"))
        schemas[p.name] = doc
        registry = registry.with_resource(
            doc["$id"], Resource.from_contents(doc, default_specification=DRAFT202012)
        )
    return registry, schemas


# 样例里的脱敏占位值。schema 描述的是**真实数据**的约束（学号是纯数字），
# 所以校验前把占位值换成同长度的假学号，否则会误报「不符合 ^\d{6,16}$」。
UNMASK = {"2024xxxxxx": "2024123456"}


def unmask(node):
    if isinstance(node, str):
        return UNMASK.get(node, node)
    if isinstance(node, list):
        return [unmask(x) for x in node]
    if isinstance(node, dict):
        return {k: unmask(v) for k, v in node.items()}
    return node


def main() -> int:
    registry, schemas = build_registry()
    ok = True

    for case in CASES:
        rel = case["file"]
        schema_name = case["schema"]
        sub = case.get("sub", "")
        defn = case.get("defn", "")

        path = ROOT / rel
        if not path.exists():
            # data/ 下的文件被 .gitignore 挡着，别人克隆后可能没有；缺了只提示
            print(f"SKIP {rel}（文件不存在）")
            continue

        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if sub:
            data = data.get(sub)
        if case.get("unmask"):
            data = unmask(data)

        schema_doc = schemas[schema_name]
        if defn:
            schema_doc = schema_doc["$defs"][defn]

        targets = data if isinstance(data, list) else [data]
        v = Draft202012Validator(schema_doc, registry=registry)
        errs = [(i, e) for i, item in enumerate(targets) for e in v.iter_errors(item)]

        label = f"{rel}" + (f"[{sub}]" if sub else "") + " -> " + schema_name + (f"#{defn}" if defn else "")
        if errs:
            ok = False
            print(f"FAIL {label}")
            for i, e in errs[:5]:
                print(f"    [{i}]", "/".join(map(str, e.path)), ":", e.message)
            if len(errs) > 5:
                print(f"    … 共 {len(errs)} 处")
        else:
            print(f"OK   {label}（{len(targets)} 条）")

    for rel in JSON_ONLY:
        path = ROOT / rel
        if not path.exists():
            print(f"SKIP {rel}")
            continue
        json.loads(path.read_text(encoding="utf-8-sig"))  # 只确认是合法 JSON
        print(f"OK   {rel}（合法 JSON，不套 schema）")

    print("\nRESULT:", "ALL PASS" if ok else "HAS FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
