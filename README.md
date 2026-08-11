# ntermx

A cyberpunk-themed **PowerShell** terminal built with Electron. Magenta, cyan
and yellow neon palette with a CRT scanline vibe.

![palette](https://img.shields.io/badge/palette-magenta%20%7C%20cyan%20%7C%20yellow-ff00aa)

## Features

- Real PowerShell process (PowerShell 7 if available, falls back to 5.1)
- Loads your PowerShell profile as-is: your own prompt stays untouched. The
  shell init only *wraps* it to emit OSC 7, so the status bar can follow the cwd
- Tabs: one PowerShell per tab (`Ctrl+Shift+T` new, `Ctrl+Shift+W` close,
  `Ctrl+Tab` to cycle), up to 8
- Lives in the system tray and toggles with the global `Ctrl+Alt+T` hotkey —
  closing the window hides it, the shells keep running
- **UTF-8 console.** ConPTY hands the shell a console that starts on the system
  OEM code page (850 on a Spanish Windows), so any native `.exe` writing raw
  UTF-8 bytes got mangled — `Córdoba` arrived as `C├│rdoba`. The shell init puts
  the console on 65001, which applies to every child process
- xterm.js frontend with the DOM renderer + clickable links + auto-fit. DOM and
  not WebGL on purpose: the WebGL addon rasterises glyphs into a texture atlas
  and clips italics, so PSReadLine's autocomplete hint rendered like a subscript
- Fonts are vendored, not fetched: full JetBrains Mono TTF (box drawing and
  block elements included, so TUI frames don't come apart) plus Noto Sans
  Symbols 2 for braille spinners
- Scanlines, cursor glow and neon scrollbar
- Secure by default: context isolation on, node integration off, CSP in place

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on Node 22)
- Windows (uses `pwsh.exe` / `powershell.exe`)
- For native build of `node-pty`: Visual Studio Build Tools + Python
  (install fails otherwise; see Troubleshooting below)

## Getting started

```bash
npm install
npm start
```

## Build an installer

Built with [electron-builder](https://www.electron.build/). Output lands in
`dist/`.

```bash
npm run dist          # NSIS installer + portable, x64
npm run dist:nsis     # installer only
npm run dist:portable # portable .exe only
```

## Project layout

```
build/
  icon.ico            App + installer icon
  icon.png            Same icon, 512px source
scripts/
  fix-node-pty-spectre.js  Postinstall patch for the node-pty native build
  font-coverage.js         Checks a TTF actually covers the ranges we rely on
src/
  main.js             Electron main: window, ptys, tray, global hotkey
  preload.js          Secure IPC bridge
  prompt.ps1          Shell init: UTF-8 console + wraps the prompt to emit OSC 7
  ntermx-tray.ico     Tray icon (small sizes only)
  renderer/
    index.html        Markup + CSP
    strop-tokens.css  Design tokens (cyan accent, magenta alt)
    styles.css        Cyberpunk theme + scanlines
    fonts.css         Vendored @font-face declarations
    fonts/            JetBrains Mono, Noto Sans Symbols 2, Inter (+ OFL licences)
    renderer.js       Tabs, xterm.js setup, cursor glow, IPC wiring
```

## Troubleshooting

**`node-pty` install fails with `gyp` errors.** It is a native module and
needs a C++ toolchain. Install the **Desktop development with C++** workload
from [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
plus Python, then `npm install` again. As an alternative you can swap the
dependency in `package.json` for the prebuilt fork
`node-pty-prebuilt-multiarch`.

**Accented characters come out as `C├│rdoba` instead of `Córdoba`.** That is the
console code page, not the font. ConPTY starts the shell on the system OEM code
page, so a native `.exe` writing raw UTF-8 bytes gets decoded wrong — and since
an accented character is two bytes in UTF-8, you get two glyphs. ntermx fixes
this from `src/prompt.ps1`; if you see it in another terminal, `chcp 65001` in
that session is the equivalent.

## Licence

ntermx is MIT — see [LICENSE](LICENSE).

The bundled typefaces are **not** MIT. All three ship under the
[SIL Open Font License 1.1](https://scripts.sil.org/OFL), whose terms travel
with the files:

| Font | Copyright | Licence |
|---|---|---|
| JetBrains Mono | 2020 The JetBrains Mono Project Authors | [OFL-JetBrainsMono.txt](src/renderer/fonts/OFL-JetBrainsMono.txt) |
| Inter | 2016 The Inter Project Authors | [OFL-Inter.txt](src/renderer/fonts/OFL-Inter.txt) |
| Noto Sans Symbols 2 | 2022 The Noto Project Authors | [OFL-NotoSansSymbols2.txt](src/renderer/fonts/OFL-NotoSansSymbols2.txt) |
