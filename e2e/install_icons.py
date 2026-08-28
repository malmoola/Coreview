#!/usr/bin/env python3
"""Name, sanitise and install a converted icon set into the local library.

Mirrors what Coreview's importer must do at runtime, so the rules live in one
readable place:

  - strip <script>, <foreignObject>, <image>
  - strip every on* event handler attribute
  - strip href/xlink:href that is not a local fragment (#id)

Cisco artwork is NOT copied into the repo. It lands in the user's own library
directory only.

  python3 e2e/install_icons.py <svg-dir> <manifest.json> [dest]
"""
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
DROP_TAGS = {f"{{{SVG_NS}}}script", f"{{{SVG_NS}}}foreignObject", f"{{{SVG_NS}}}image"}


def slug(name: str) -> str:
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    n = re.sub(r"[^\w\s-]", "", n).strip().lower()
    n = re.sub(r"[\s_]+", "-", n)
    return re.sub(r"-{2,}", "-", n) or "icon"


def sanitise(path: Path):
    ET.register_namespace("", SVG_NS)
    removed = []
    root = ET.parse(path).getroot()

    for parent in root.iter():
        for child in list(parent):
            if child.tag in DROP_TAGS:
                parent.remove(child)
                removed.append(child.tag.split("}")[-1])

    for el in root.iter():
        for attr in list(el.attrib):
            local = attr.lower().split("}")[-1]
            if local.startswith("on"):
                del el.attrib[attr]
                removed.append(attr)
            elif local == "href":
                val = el.attrib[attr].strip()
                if not val.startswith("#"):
                    del el.attrib[attr]
                    removed.append(f"href={val[:24]}")

    return ET.tostring(root, encoding="unicode"), removed


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    manifest = json.loads(Path(sys.argv[2]).read_text())
    dest = Path(sys.argv[3]) if len(sys.argv) > 3 else Path.home() / ".local/share/coreview/icons"
    dest.mkdir(parents=True, exist_ok=True)

    by_file = {m["file"]: m for m in manifest}
    out, used, skipped, all_removed = [], set(), 0, []

    for svg in sorted(src.glob("*.svg")):
        meta = by_file.get(svg.name.replace(".svg", ".emf")) or by_file.get(svg.name)
        if not meta:
            skipped += 1
            continue
        base = slug(meta["name"])
        name, i = base, 2
        while name in used:
            name, i = f"{base}-{i}", i + 1
        used.add(name)

        text, removed = sanitise(svg)
        all_removed += removed
        (dest / f"{name}.svg").write_text(text)
        out.append({"id": name, "name": meta["name"], "category": meta["category"], "file": f"{name}.svg"})

    (dest / "index.json").write_text(json.dumps({"icons": out}, indent=1))
    print(f"installed {len(out)} icons -> {dest}")
    if skipped:
        print(f"  skipped (no manifest entry): {skipped}")
    print("  sanitiser removed:", dict(Counter(all_removed)) or "nothing")
    cats = Counter(m["category"] for m in out)
    for c, n in cats.most_common():
        print(f"    {n:3d}  {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
