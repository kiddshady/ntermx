# Argon

A cyberpunk-themed **PowerShell** terminal built with Electron. Magenta, cyan
and yellow neon palette with a CRT scanline vibe.

![palette](https://img.shields.io/badge/palette-magenta%20%7C%20cyan%20%7C%20yellow-ff00aa)

## Features

- Real PowerShell process (PowerShell 7 if available, falls back to 5.1)
- Loads your PowerShell profile as-is: your own prompt stays untouched. The
  shell init only *wraps* it to emit OSC 7, so the status bar can follow the cwd
- Tabs: one PowerShell per tab (`Ctrl+Shift+T` new, `Ctrl+Shift+W` close,
  `Ctrl+Tab` to cycle), up to 8
- Lives in the system tray, single instance only, and toggles with the global
  `Ctrl+Alt+T` hotkey — closing the window hides it, the shells keep running
- xterm.js frontend with WebGL renderer + clickable links + auto-fit
- Scanlines, cursor glow and neon scrollbar
- Secure by default: context isolation on, node integration off

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

Built with [electron-builder](https://www.electron.build/) (same as Console and
Umbra). Output lands in `dist/`.

```bash
npm run dist          # NSIS installer + portable, x64
npm run dist:nsis     # installer only
npm run dist:portable # portable .exe only
```

## Project layout

```
build/
  icon.ico       App + installer icon
  icon.png       Same icon, 512px source
src/
  main.js        Electron main: window, ptys, tray, single instance, hotkey
  preload.js     Secure IPC bridge
  prompt.ps1     Shell init: wraps the existing prompt to emit OSC 7
  argon-tray.ico   Tray icon (small sizes only)
  renderer/
    index.html   Markup + CSP
    styles.css   Cyberpunk theme + scanlines
    renderer.js  Tabs, xterm.js setup, cursor glow, IPC wiring
```

## Troubleshooting

**`node-pty` install fails with `gyp` errors.** It is a native module and
needs a C++ toolchain. Install the **Desktop development with C++** workload
from [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
plus Python, then `npm install` again. As an alternative you can swap the
dependency in `package.json` for the prebuilt fork
`node-pty-prebuilt-multiarch`.
