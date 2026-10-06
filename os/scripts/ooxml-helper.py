#!/usr/bin/env python3
"""
ooxml-helper — OOXML（.docx/.xlsx/.pptx）读写辅助脚本（纯 Python 标准库，零依赖）

存在理由：ximo-OS 主机是 Linux 且无 pip / 无 LibreOffice / 无 officecli.exe
（后者是 Windows PE 二进制，主应用用）。而 OOXML 本质是 zip + XML —— 标准库
足以读取文本内容与表格，无需任何第三方包，可在最小镜像里直接跑。

用法（由 host 的 office 工具调用，输出 JSON 到 stdout）：
  ooxml-helper.py read  <file>            读全文（段落 + 表格）
  ooxml-helper.py info  <file>            文档结构摘要（段落数/表格数/字数）
  ooxml-helper.py sheets <file>           列出工作表与单元格范围（仅 xlsx）
  ooxml-helper.py replace <file> <old> <new>  全文替换（docx/xlsx/pptx 共享字符串）

限制（如实声明，不假装支持）：
  - 只处理 OOXML（.docx/.xlsx/.pptx）。旧格式 .doc/.xls/.ppt 是二进制，不支持。
  - 不做格式保真编辑（不新建复杂排版）。复杂生成请在 GUI 应用里做（desktop 工具）。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def die(msg: str, code: int = 1):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def open_zip(path: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        die(f"不是有效的 OOXML 文件（应为 zip 容器）：{path}")
    except FileNotFoundError:
        die(f"文件不存在：{path}")


def strip_tags(elem) -> str:
    """提取元素下所有文本（含嵌套 run）"""
    return "".join(t.text or "" for t in elem.iter() if t.tag.endswith("}t") or t.tag == "t")


def local(tag: str) -> str:
    """去掉命名空间前缀 — OOXML 各部件命名空间不一，按本地名匹配最稳"""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def find_all(elem, name: str):
    """按本地名查找后代元素（忽略命名空间）"""
    return [e for e in elem.iter() if local(e.tag) == name]


def children_named(elem, name: str):
    """按本地名查找直接子元素"""
    return [e for e in elem if local(e.tag) == name]


def read_docx(z: zipfile.ZipFile) -> dict:
    if "word/document.xml" not in z.namelist():
        die("不是有效的 .docx（缺 word/document.xml）")
    root = ET.fromstring(z.read("word/document.xml"))
    body = next((c for c in root if local(c.tag) == "body"), None)
    paragraphs, tables = [], []
    if body is not None:
        for child in body:
            tag = local(child.tag)
            if tag == "p":
                paragraphs.append(strip_tags(child))
            elif tag == "tbl":
                rows = []
                for tr in children_named(child, "tr"):
                    cells = [strip_tags(tc) for tc in children_named(tr, "tc")]
                    rows.append(cells)
                tables.append(rows)
    return {"type": "docx", "paragraphs": paragraphs, "tables": tables}


def read_xlsx(z: zipfile.ZipFile) -> dict:
    # 共享字符串表（按本地名 si 匹配 — 真实文件命名空间前缀不一）
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        sroot = ET.fromstring(z.read("xl/sharedStrings.xml"))
        shared = [strip_tags(si) for si in children_named(sroot, "si")]
    # 工作表名（workbook.xml 的 sheet 元素带 name 属性）
    names: list[str] = []
    if "xl/workbook.xml" in z.namelist():
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        names = [s.get("name", "") for s in find_all(wb, "sheet") if s.get("name")]
    sheets = []
    for idx, name in enumerate(names or ["Sheet1"], start=1):
        path = f"xl/worksheets/sheet{idx}.xml"
        if path not in z.namelist():
            continue
        ws = ET.fromstring(z.read(path))
        rows = []
        for row in find_all(ws, "row"):
            cells = []
            for c in children_named(row, "c"):
                t = c.get("t")
                v = next((x for x in c if local(x.tag) == "v"), None)
                val = v.text if v is not None and v.text is not None else ""
                if t == "s" and val.isdigit() and int(val) < len(shared):
                    val = shared[int(val)]
                elif t == "inlineStr":
                    val = strip_tags(c)
                cells.append({"ref": c.get("r", ""), "value": val})
            rows.append(cells)
        sheets.append({"name": name, "rows": rows})
    return {"type": "xlsx", "sheets": sheets}


def read_file(path: str) -> dict:
    z = open_zip(path)
    names = z.namelist()
    if "word/document.xml" in names:
        return read_docx(z)
    if "xl/workbook.xml" in names or any(n.startswith("xl/worksheets/") for n in names):
        return read_xlsx(z)
    if any(n.startswith("ppt/slides/") for n in names):
        slides = []
        for n in sorted(x for x in names if re.match(r"ppt/slides/slide\d+\.xml$", x)):
            root = ET.fromstring(z.read(n))
            slides.append(strip_tags(root))
        return {"type": "pptx", "slides": slides}
    die(f"不支持的 OOXML 类型：{path}（仅 .docx/.xlsx/.pptx）")


def format_text(doc: dict) -> str:
    """转可读文本（供 LLM 消费）"""
    out: list[str] = []
    if doc["type"] == "docx":
        for p in doc["paragraphs"]:
            out.append(p)
        for i, t in enumerate(doc["tables"], 1):
            out.append(f"\n[表格 {i}]")
            for row in t:
                out.append(" | ".join(row))
    elif doc["type"] == "xlsx":
        for sh in doc["sheets"]:
            out.append(f"[工作表: {sh['name']}]")
            for row in sh["rows"]:
                out.append(" | ".join(c["value"] for c in row))
    elif doc["type"] == "pptx":
        for i, s in enumerate(doc["slides"], 1):
            out.append(f"[幻灯片 {i}] {s}")
    return "\n".join(out)


def main() -> None:
    if len(sys.argv) < 3:
        die("用法: ooxml-helper.py <read|info|sheets|replace> <file> [args]")
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "read":
        doc = read_file(path)
        print(json.dumps({"ok": True, "type": doc["type"], "text": format_text(doc)}, ensure_ascii=False))
    elif cmd == "info":
        doc = read_file(path)
        chars = len(format_text(doc))
        extra = {}
        if doc["type"] == "docx":
            extra = {"paragraphs": len(doc["paragraphs"]), "tables": len(doc["tables"])}
        elif doc["type"] == "xlsx":
            extra = {"sheets": len(doc["sheets"]), "rows": sum(len(s["rows"]) for s in doc["sheets"])}
        elif doc["type"] == "pptx":
            extra = {"slides": len(doc["slides"])}
        print(json.dumps({"ok": True, "type": doc["type"], "chars": chars, **extra}, ensure_ascii=False))
    elif cmd == "sheets":
        doc = read_file(path)
        if doc["type"] != "xlsx":
            die("sheets 仅适用于 .xlsx")
        info = [
            {"name": s["name"], "rows": len(s["rows"]), "range": (s["rows"][-1][-1]["ref"] if s["rows"] and s["rows"][-1] else "")}
            for s in doc["sheets"]
        ]
        print(json.dumps({"ok": True, "sheets": info}, ensure_ascii=False))
    elif cmd == "replace":
        if len(sys.argv) < 5:
            die("用法: ooxml-helper.py replace <file> <old> <new>")
        old, new = sys.argv[3], sys.argv[4]
        z = open_zip(path)
        targets = [n for n in z.namelist() if n.endswith(".xml") and n != "[Content_Types].xml"]
        count = 0
        import shutil, tempfile, os
        tmp = tempfile.mktemp(suffix=".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
            for item in z.infolist():
                data = z.read(item.filename)
                if item.filename in targets:
                    text = data.decode("utf-8", errors="ignore")
                    if old in text:
                        count += text.count(old)
                        text = text.replace(old, new)
                        data = text.encode("utf-8")
                out.writestr(item, data)
        shutil.move(tmp, path)
        print(json.dumps({"ok": True, "replacements": count}, ensure_ascii=False))
    else:
        die(f"未知命令：{cmd}")


if __name__ == "__main__":
    main()
