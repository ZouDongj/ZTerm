# ZTerm

A modern terminal emulator for Windows with first-class SSH management, split panes, and SFTP file transfer.

Built with [Tauri 2](https://tauri.app/) and [xterm.js](https://xtermjs.org/), styled with a Material-You-inspired dark theme.

## Features

- **Multi-tab terminal** — PowerShell, CMD, Git Bash, WSL auto-detection
- **SSH manager** — Profile groups, DPAPI-encrypted passwords, public key auth, one-click connect
- **SSH hardening** — Known-hosts TOFU with host-key change confirmation (MITM protection)
- **Login scripts** — Auto-respond to terminal prompts after SSH login (Expect/Send rules)
- **Follow CWD** — The SFTP panel follows your SSH terminal's current directory (OSC 7)
- **Split panes** — Horizontal & vertical splits, drag-to-reorder with smooth animations, maximize, resize
- **SFTP panel** — Browse, upload, download, drag-and-drop, transfer progress & cancellation
- **12 color schemes** — One Dark Pro, Catppuccin, Nord, Dracula, Tokyo Night, and more
- **Quick Commands** — Fuzzy-searchable macro library with groups
- **Custom highlights** — Regex/keyword-based ANSI color injection
- **Customizable shortcuts** — Record-style keybinding editor

## Screenshots

<!-- TODO: add screenshots -->

## Install

Download the latest installer from [Releases](https://github.com/ZouDongj/zterm/releases). The NSIS installer is ~4 MB and needs no separate runtime — it uses the system WebView2 (preinstalled on Windows 10/11).

## Build from source

Prerequisites: [Rust](https://rustup.rs/) (stable), [Node.js](https://nodejs.org/) 18+, and the [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2, MSVC build tools).

```bash
git clone https://github.com/ZouDongj/zterm.git
cd zterm/ZTerm
npm install          # installs @tauri-apps/cli
npm run dev          # run in development mode
```

To build the release installer (NSIS, x64):

```bash
npm run build
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

## Verification

`npm run e2e` launches a release build and drives it through the WebView2 debugging protocol to verify that interactive elements actually work at runtime (CSP-effective `unsafe-inline`, compiled `onclick` handlers, window minimize/maximize/restore, menu interaction, IPC reachability). This catches issues that unit tests and syntax checks cannot — e.g. a CSP change that silently disables every inline click handler. Requires Node 22+ and a desktop session. The same checks run in CI after every push.

## Tech Stack

- [Tauri 2](https://tauri.app/) — App framework (Rust backend + WebView2)
- [xterm.js](https://xtermjs.org/) — Terminal rendering
- [russh](https://github.com/warp-tech/russh) — Pure-Rust SSH client
- [portable-pty](https://github.com/wez/wezterm) — Pseudoterminal (ConPTY)
- [russh-sftp](https://github.com/warp-tech/russh-sftp) — SFTP protocol
- [arboard](https://github.com/1Password/arboard) — System clipboard
- Zero frontend framework — vanilla HTML/CSS/JS

### Data & Security

- Configuration lives in `%APPDATA%\ZTerm\config.json` (dev) or `<install dir>\data\config.json` (packaged), with `%APPDATA%\ZTerm` acting as the anchor/fallback
- SSH passwords are encrypted with Windows DPAPI and never stored in plaintext
- Server host keys are tracked with Trust-On-First-Use; key changes trigger a confirmation dialog

## License

MIT © 2026 zoudongjie

See [LICENSE](LICENSE) for details. Third-party notices: xterm.js and its addons are distributed under the MIT license; see `src/vendor/` for their bundled sources.
