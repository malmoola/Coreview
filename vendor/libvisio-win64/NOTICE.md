# Bundled Visio reader (Windows)

LT-080: `.vss`/`.vssx`/`.vsd`/`.vsdx` import runs `vss2xhtml`/`vsd2xhtml` from
[libvisio](https://gitlab.freedesktop.org/libreoffice/libvisio). Linux has a
`libvisio-tools` package; Windows has none, so the two executables and their
runtime DLLs are carried here and installed alongside the app
(`src-tauri/tauri.windows.conf.json`) instead of asking every operator to
build libvisio themselves.

Every file in this folder is an unmodified binary built by the
[MSYS2](https://www.msys2.org/) project's `mingw64` repository — nothing here
was compiled by Coreview. Source packages and build recipes:
<https://github.com/msys2/MINGW-packages>.

| File(s) | Package | Version | Licence |
| --- | --- | --- | --- |
| `vss2xhtml.exe`, `vsd2xhtml.exe`, `libvisio-0.1.dll` | `mingw-w64-x86_64-libvisio` | 0.1.11-2 | MPL-2.0 |
| `librevenge-0.0.dll`, `librevenge-stream-0.0.dll` | `mingw-w64-x86_64-librevenge` | 0.0.6-1 | MPL-2.0 OR LGPL-2.1-or-later |
| `libxml2-16.dll` | `mingw-w64-x86_64-libxml2` | 2.15.3-3 | MIT |
| `zlib1.dll` | `mingw-w64-x86_64-zlib` | 1.3.2-2 | Zlib |
| `libiconv-2.dll` | `mingw-w64-x86_64-libiconv` | 1.19-1 | LGPL-2.1-or-later |
| `libicudt78.dll`, `libicuuc78.dll` | `mingw-w64-x86_64-icu` | 78.3-4 | ICU (Unicode-DFS) |
| `libgcc_s_seh-1.dll`, `libstdc++-6.dll` | `mingw-w64-x86_64-gcc-libs` | 16.2.0-3 | GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later |
| `libwinpthread-1.dll` | `mingw-w64-x86_64-libwinpthread` | 14.0.0.r353.g6df76fa52-2 | MIT AND BSD-3-Clause-Clear |

The GCC runtime exception on `libgcc_s_seh-1.dll`/`libstdc++-6.dll` permits
distributing them alongside a proprietary or differently-licensed
application; the LGPL pieces (`libvisio`/`librevenge`'s LGPL option,
`libiconv`) are shipped as separate, unmodified, dynamically-linked DLLs — no
static linking, no source changes — which satisfies LGPL §4/§6 without
placing any further licence obligation on Coreview itself.

`src-tauri/src/shapeconv.rs` calls `vss2xhtml`/`vsd2xhtml` by name; on
Windows it resolves them from this bundled folder first and falls back to
`PATH` (so a developer who happens to have libvisio installed already isn't
forced through the bundle). See `visio_tool_path` in that file.
