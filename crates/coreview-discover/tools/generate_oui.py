#!/usr/bin/env python3
"""Turns the IEEE OUI registry into the table src/oui_data.rs.

    curl -o oui.csv https://standards-oui.ieee.org/oui/oui.csv
    python3 crates/coreview-discover/tools/generate_oui.py oui.csv

The registry is 3.8 MB of CSV with postal addresses in it. This keeps the
assignment and a shortened organisation name, which is all a diagram label
needs, and sorts by prefix so the lookup can binary search.
"""
import csv
import re
import sys

# Legal suffixes are noise on a diagram: "Cisco Systems, Inc" and "Cisco
# Systems" are the same thing to someone reading a network map.
SUFFIXES = [
    r",?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|l\.l\.c|gmbh|ag|s\.a|sa|s\.p\.a|spa|b\.v|bv|n\.v|nv|a/s|as|oy|ab|plc|pty|pte|srl|s\.r\.l|kg|kk|k\.k)\.?$",
    r",?\s+(technologies|technology|electronics|electronic|systems|system|networks|solutions)\s+(inc|corp|co|ltd|llc|gmbh)\.?$",
]


def clean(name: str) -> str:
    """Drops characters the registry carries that source code should not.

    Zero-width spaces and other invisibles appear in a handful of entries and
    are rejected outright by `clippy -D warnings`, so this is not cosmetic.
    """
    return "".join(c for c in name if c.isprintable() and not c.isspace() or c == " ")


def shorten(name: str) -> str:
    n = " ".join(clean(name).split()).strip().strip(",")
    for _ in range(3):
        before = n
        for pattern in SUFFIXES:
            n = re.sub(pattern, "", n, flags=re.IGNORECASE).strip().strip(",")
        if n == before:
            break
    # A name that shortened away to nothing keeps its original.
    return n if n else " ".join(name.split())


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1

    entries = {}
    with open(sys.argv[1], newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            if row.get("Registry") != "MA-L":
                continue
            assignment = (row.get("Assignment") or "").strip().upper()
            org = (row.get("Organization Name") or "").strip()
            if len(assignment) != 6 or not org or org.lower() == "private":
                continue
            try:
                prefix = int(assignment, 16)
            except ValueError:
                continue
            entries[prefix] = shorten(org)

    # Half the assignments repeat an organisation — Cisco alone holds
    # hundreds — so the names are deduplicated and referenced by index. As
    # 40,000 separate string literals the table costs 2.2 MB of binary; this
    # brings it down to a fraction of that.
    names = sorted({v for v in entries.values()})
    index = {name: i for i, name in enumerate(names)}
    assert len(names) < 65536, "the index no longer fits in a u16"

    out = [
        "//! Generated from the IEEE MA-L registry by tools/generate_oui.py.",
        "//!",
        "//! Do not edit. Regenerate when the registry is refreshed:",
        "//!",
        "//! ```text",
        "//! curl -o oui.csv https://standards-oui.ieee.org/oui/oui.csv",
        "//! python3 crates/coreview-discover/tools/generate_oui.py oui.csv",
        "//! ```",
        "",
        "/// Every organisation name, once each.",
        "pub static VENDORS: &[&str] = &[",
    ]
    for name in names:
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        out.append(f'    "{escaped}",')
    out.append("];")
    out.append("")
    out.append("/// The first three bytes of a MAC, and an index into VENDORS.")
    out.append("/// Sorted by prefix, so the lookup can binary search.")
    out.append("pub static OUI: &[(u32, u16)] = &[")
    for prefix in sorted(entries):
        out.append(f"    (0x{prefix:06X}, {index[entries[prefix]]}),")
    out.append("];")
    out.append("")

    path = "crates/coreview-discover/src/oui_data.rs"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))
    print(f"{len(entries)} prefixes -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
