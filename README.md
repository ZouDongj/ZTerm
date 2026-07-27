# ZTerm

A modern terminal emulator for Windows with first-class SSH management, flexible split panes, and SFTP file transfer.

## Features

- **Multi-tab terminal** — PowerShell, CMD, Git Bash, WSL auto-detection
- **SSH manager** — Profile groups, password encryption (DPAPI), key auth, one-click connect
- **Login scripts** — Auto-respond to terminal prompts after SSH login (Expect/Send rules)
- **Split panes** — Horizontal & vertical splits, drag-to-reorder, maximize, resize
- **SFTP panel** — Browse, upload, download, drag-and-drop, follow terminal directory
- **12 color schemes** — One Dark Pro, Catppuccin, Nord, Dracula, Tokyo Night, and more
- **Quick Commands** — Fuzzy-searchable macro library with groups
- **Custom highlights** — Regex/keyword-based ANSI color injection
- **Customizable shortcuts** — Record-style keybinding editor

## Install

Download the latest installer from [Releases](https://github.com/ZouDongj/zterm/releases).

## Build from source

```bash
git clone https://github.com/ZouDongj/zterm.git
cd zterm/ZTerm
npm install
npm start
```

To create an installer:

```bash
npm run dist
```

## Tech Stack

- [Electron](https://www.electronjs.org/) — App framework
- [xterm.js](https://xtermjs.org/) — Terminal rendering
- [node-pty](https://github.com/microsoft/node-pty) — Pseudoterminal (ConPTY)
- [russh](https://github.com/zoudongjie/russh) — Rust SSH client (NAPI bindings)
- Zero frontend framework — vanilla HTML/CSS/JS

## License

MIT © 2026 zoudongjie
