#!/usr/bin/env python3
"""校验 examples/ 下的真实数据是否符合 docs/schema/ 里的 JSON Schema。

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

# 样例文件 -> (描述它的 schema, 取哪个子路径)
# 子路径用 ""：整个文件就是一条/一组；用 "items"：取对象里的数组逐条校验
CASES = [
    ("app-events.json", "event.schema.json", ""),
    ("ddls-local.json", "ddl.schema.json", ""),
    ("checkins-local.json", "checkin.schema.json", ""),
    ("personal-items.json", "personal-item.schema.json", ""),
    ("ddls-lms.json", "ddl-input.schema.json", "items"),
    ("sync-payload.json", "sync-payload.schema.json", ""),
    ("files/timetable-2026-2027-1.json", "timetable-file.schema.json", ""),
    ("files/personal-2026-11-08.json", "personal-file.schema.json", ""),
]

# 只做结构展示、不参与 schema 校验的上游原始数据（字段名与实体不同）
RAW_ONLY = [
    "cloud-events.json",
    "sources/lms-todos-raw.json",
    "sources/weflow-chatroom.json",
    "sources/board-notice.json",
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


def main() -> int:
    registry, schemas = build_registry()
    ok = True

    for rel, schema_name, sub in CASES:
        path = EX / rel
        if not path.exists():
            print(f"SKIP {rel}（文件不存在）")
            continue
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if sub:
            data = data.get(sub, [])
        targets = data if isinstance(data, list) else [data]

        v = Draft202012Validator(schemas[schema_name], registry=registry)
        errs = [(i, e) for i, item in enumerate(targets) for e in v.iter_errors(item)]
        if errs:
            ok = False
            print(f"FAIL {rel} -> {schema_name}")
            for i, e in errs[:5]:
                print(f"    [{i}]", "/".join(map(str, e.path)), ":", e.message)
        else:
            print(f"OK   {rel} -> {schema_name}（{len(targets)} 条）")

    for rel in RAW_ONLY:
        path = EX / rel
        if not path.exists():
            print(f"SKIP {rel}")
            continue
        json.loads(path.read_text(encoding="utf-8-sig"))  # 只确认是合法 JSON
        print(f"OK   {rel}（原始结构，不套 schema）")

    print("\nRESULT:", "ALL PASS" if ok else "HAS FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
