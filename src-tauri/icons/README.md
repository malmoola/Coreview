`icon.ico` is a generated placeholder (a link ring with three packet dots) so the
Windows bundler has something valid to embed. Replace it with real artwork before
shipping — `npm run tauri icon path\to\source.png` regenerates every size Tauri
needs from one 1024x1024 PNG.
