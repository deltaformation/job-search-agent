# R1-D Handoff — Supervisor, Storage, and Security

Status: accepted 2026-09-11. Branch: `rebuild/r1-platform` (R1-A + R1-B
+ R1-C + R1-D files uncommitted in working tree; R0 checkpoint is commit
`de8a533` on `main`).

## Outcome

One-command local runtime: `npm run dev` / `npm run start` prepare storage
+ migrations and supervise the Next.js web process plus the worker with
signal forwarding and fail-fast crash policy. New `src/security/` layer
(data roots, artifact paths, Host/Origin/CSRF rules, headers, redacted
structured logs), a worker lifecycle stub, middleware Host gate + headers,
a filesystem-only `/api/health` probe, and 39 new tests. No new
dependencies.

## How it runs

- `scripts/supervise.mjs` spawns argv-array children (never shell strings),
  prefixes log lines, forwards SIGINT/SIGTERM with a SIGKILL grace period,
  and exits 0 only when every child exited 0. No auto-restart.
- `scripts/dev.mjs` / `start.mjs` validate HOST (loopback-only refusal) and
  PORT, run setup (data root + `ensureDatabase`), then supervise
  `next dev|start` + the worker. `start` refuses without `.next/BUILD_ID`.
- `scripts/migrate.mjs` (`npm run db:migrate`) runs setup standalone.
- Plain Node 24 runs repository TS via native type stripping plus a tiny
  local resolve hook (`scripts/ts-loader.mjs`) that maps extensionless
  relative imports (and same-name file-over-directory) to `.ts`. No tsx,
  no build step for scripts/worker.
- Worker (`src/worker/main.ts`) opens the supervised DB, refuses
  unmigrated files, logs ready, idles on a 30s debug heartbeat, and closes
  cleanly on SIGINT/SIGTERM. Dispatch arrives in R2-B.

## Security posture

- Middleware 403s any non-allowlisted Host (rebinding protection) on all
  routes and stamps breakage-free headers (nosniff, DENY, no-referrer,
  locked-down Permissions-Policy). CSP ships report-only until the UI
  stabilizes enough for nonces — deliberate, documented in `headers.ts`.
- `verifyMutationRequest` (Host + Origin-or-same-origin-fetch) is the
  per-route mutation gate R3/R4 handlers must call; headerless non-browser
  clients must send `Origin:` explicitly (documented behavior).
- Stored `relative_path` values resolve only via `resolveArtifactPath`
  (shape + containment + symlink-segment walk, macOS `/tmp`-safe).
- Logs are one JSON line each with secret-key redaction; explicit email /
  phone masking helpers for identifier fields.

## Verification evidence (all on Node v24.21.0 unless noted)

- `tsc --noEmit`: exit 0. `eslint .`: exit 0, no output.
- `vitest run`: 27 files, 130/130 passed (39 new; all 91 prior green).
- `node scripts/check-project-context.mjs`: consistent.
- `next build --webpack`: success (3 static pages, dynamic `/api/health`,
  middleware proxy). Stock Turbopack build fails only on the sandbox port
  block, same as R0/R1-A baseline — needs user-side rerun.
- Real `scripts/start.mjs` smoke with temp root: created
  `artifacts/ evidence/ job-tracker.sqlite`, web bind failed with sandbox
  EPERM as expected, supervisor prefixed the error, stopped the worker,
  and exited 1 with `web exited with code 1`. Failure path proven
  end to end; the success path (ports) needs user-side `npm run dev`.
- Bugs found by tests and fixed: worker heartbeat keepalive (the stub
  self-exited before signals — would have killed `npm run dev` instantly),
  piped-output flush barriers on every exit path, `DATABASE_PATH`
  override honored, Host `#`/`?` rejection.

## Decisions and deviations

- Worker heartbeat interval (not bare signal-await) keeps the event loop
  alive; R2-B replaces the idle wait with dispatch.
- `flushStdio` barriers (TS + `.mjs` twins) precede every process exit so
  supervised final lines are never dropped on loop drain.
- Health route opens no database (fs inventory + migration list only) so
  no native module enters the Next bundle and no `next.config.ts` change
  was needed.
- Enforcing CSP deferred to post-UI-stabilization hardening (R5); the
  report-only tripwire plus enforcing sibling headers ship now.
- Additive-only contact with R1-A areas: new `middleware.ts`,
  `app/api/health/route.ts`, and rewired `dev`/`start` + new `db:migrate`
  scripts (R1-D explicitly owns root startup scripts). No existing R1-A
  file content changed.
- Scratch repro scripts live in `/tmp` (kept, per convention), never in
  the repo.

## Ready next

R1 is feature-complete once R1-B (accepted), R1-C, and R1-D reviews close
plus one user-side `npm run dev` smoke (page + `/api/health` 200 +
clean Ctrl-C). Then R2-A (URL policy) and R2-B (queue + dispatch) unblock;
both consume `src/domain`, `src/security`, and the worker entrypoint.
