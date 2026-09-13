# R1-A Handoff — Node/Next Application Scaffold

Status: accepted 2026-09-11. Branch: `rebuild/r1-platform` (R1-A files
uncommitted in working tree; R0 checkpoint is commit `de8a533` on `main`).

## Outcome

Pinned Next.js + React + Tailwind toolchain with a minimal accessible app
shell (layout, page, loading, error boundary), vitest + jsdom component-test
setup, and loopback-only dev/start scripts. No product logic; nothing reads
or writes product data.

## Verified pins (exact, in package.json + package-lock.json, 561 packages)

next 16.3.4, react 19.3.0, react-dom 19.3.0, typescript 5.9.3,
tailwindcss 4.3.3, @tailwindcss/postcss 4.3.3, postcss 8.5.28,
vitest 5.0.0, vite 8.3.0, @vitejs/plugin-react 6.1.1, jsdom 30.0.1,
@testing-library/react 16.3.3, @testing-library/jest-dom 7.0.1,
eslint 9.39.5, eslint-config-next 16.3.4,
@types/node 22.20.2, @types/react 19.3.0, @types/react-dom 19.3.0.
Node baseline: 24.x (`.nvmrc` = `24`, `engines` = `24.x`).

## Verification evidence (all on Node v24.21.0 unless noted)

- `tsc --noEmit`: exit 0.
- `eslint .`: exit 0, 0 errors, 0 warnings.
- `vitest run`: 1/1 passed (`tests/unit/platform-status.test.tsx`).
- `next build --webpack`: success, 3 static pages prerendered.
- Agent sandbox blocks local port binding, so the stock Turbopack
  `next build` and serve smoke were verified user-side: after
  `nvm install 24`, `npm install && npm run dev` serves the scaffold page
  correctly at http://127.0.0.1:3000. R1-A accepted on that basis.

## Decisions and deviations

- ESLint pinned to 9.39.5, not 10: v10 breaks the `eslint-plugin-react`
  bundled in `eslint-config-next` (`getFilename is not a function`).
- TypeScript kept at 5.9.3 for Next 16 compatibility (not TS 7).
- `next-env.d.ts` and `*.tsbuildinfo` gitignored as generated output.
- `test:e2e` script deferred to R5-C (Playwright owner).
- `npm install` prints an `unrs-resolver` allowScripts notice under npm 11;
  no observed impact (test + build green).

## Environment notes for the next session

- Work from the repo root (`/Users/mouadatfi/Antigravity/job`) with
  `nvm use 24`. The agent's scratch Node at `/tmp/node24` is disposable
  and may not survive a reboot; the user's `nvm install 24` is canonical.
- Next rewrote `tsconfig.json` on first build (`jsx: react-jsx`, added
  `.next/dev/types`); current content is the accepted baseline.

## Next ready work

R1-B (SQLite schema + repositories) and R1-C (domain contracts + state
machines) may proceed now that R1-A is accepted; R1-D integrates them.
