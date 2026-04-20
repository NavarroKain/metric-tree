# Metric Tree — Claude Instructions

## Git workflow

**Always work in a feature branch, never commit directly to `main`.**

At the start of any session that involves code changes:

```bash
git checkout main && git pull origin main
git checkout -b feature/<short-kebab-description>
```

Branch naming:
- `feature/` — new functionality
- `fix/` — bug fixes
- `refactor/` — restructuring without behaviour change

When the work is done, push and open a PR:

```bash
git push -u origin <branch-name>
export PATH="$PATH:/c/Program Files/GitHub CLI" && gh pr create --fill
```

`gh` is installed at `C:\Program Files\GitHub CLI\gh.exe` and authenticated as NavarroKain.

## Project overview

Single-page metric tree builder (vanilla JS, no build step).

| File | Role |
|---|---|
| `index.html` | Shell and SVG marker defs |
| `styles.css` | All styles (dark-mode via `prefers-color-scheme`) |
| `app.js` | All state, compute, render, and event logic |

Key state object: `S` in `app.js`.  
Computed values live in `S.computed[nodeId]` — never mutate them directly.

## Dev server

```bash
npx live-server --port=3001 --no-browser
```

Config is in `.claude/launch.json`.
