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
gh pr create --fill
```

If `gh` is not installed, push the branch and tell the user to open the PR at:
https://github.com/NavarroKain/metric-tree/compare

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
