# G regression case — Provider selection and key management

**Status:** open, user-reported usability blocker with supporting code inspection; no live configuration or provider request inspected. Implement within WO-1.2-G, not the post-J backlog. If G has already been handed off, perform a bounded G correction pass before treating setup acceptance as closed.

## Report

AI & Models shows OpenRouter “Connected”, Google AI Studio “Active” but “Key Missing in .env.local”, and Meta Muse missing its key. User cannot add/edit keys. Selecting OpenRouter and Save Models appears to switch back to Google. Test Connection returns “Failed: OpenRouter API error 502”. Reported model entries:

- Primary: `google/gemma-4-26b-a4b-it:free`
- Fallback: `nvidia/nemotron-3.5-lightning:free`

These names are reported inputs, not verified supported/current models. Do not silently replace them or assert they caused the failure. The user suspects model selection is why tailoring fails; establish the actual worker configuration and error path before confirming that diagnosis. Earlier `provider spawn failed: 'node'` is a distinct local launch error; HTTP 502 is a separate reported upstream response.

## Inspected behavior to reproduce

- `components/settings/SettingsModal.tsx`: `switchModelChain` saves then calls `refresh`; `applySnapshot` resets selected provider/model inputs to `data.activeProvider`.
- `src/server/settings.ts`: `switchModels` writes provider/models to the file but requires restart; running configuration still comes from process environment. Thus the UI reset alone does not prove saving failed. External environment precedence can also override file settings after restart; inspect it safely without dumping environment values.
- The provider card labels `status.configured` as “Connected”; key presence is not a successful connection test.
- `testAi` posts only provider; `app/api/settings/ai-test/route.ts` tests that provider using process environment, not the entered model/key draft.
- Current displayed provider form has model fields and no key editor. G already owns masked key add/replace/remove.

## Required G behavior and regression evidence

1. **G1:** Test the exact selected provider, entered model and transient key (or explicitly reused stored key) without saving. Invalidate results when tested inputs change. State which model was tested; distinguish primary and fallback results if both are tested. Do not imply an entire chain passed from one primary test.
2. **G2/G5:** A simulated 502 keeps the draft and current active configuration intact and shows an understandable temporary-service-error explanation with retry/check options and safe technical detail. Do not claim invalid credentials/model or a guaranteed transient cause based on status 502 alone. Verify reported model support against official provider information during implementation only if needed; keep deterministic tests separate from authorized live checks.
3. **G3:** Add/replace/remove provider keys in settings with write-only masked inputs; blank retains the stored key. Persist securely, preserve other provider settings and never return raw keys. No terminal or manual env-file editing in the user flow.
4. **G4:** Distinguish editing selection, saved configuration, web-active and worker-active configuration. Saving OpenRouter must preserve the selected saved draft on refresh/reopen; if activation awaits restart, show “OpenRouter saved — restart required” while truthfully showing Google still active. Do not silently revert the form or imply activation succeeded. Never equate missing-key configuration with readiness.
5. **G4/G6:** Complete the existing supported activation/restart flow and verify BOTH web and worker actually use the saved provider/models. If an external override prevents it, explain the conflict and a concrete supported resolution instead of looping Save. Clear restart-needed only after verified activation. Reuse G's agreed restart mechanism; no new process-management platform.
6. **G6:** Reproduce the reported state with isolated config: Google active without a key, OpenRouter key present, user selects OpenRouter, edits/tests/saves, activates, closes/reopens settings, then explicitly generates a resume through the supervised worker. Observe the bound provider/model and success with a deterministic seam. Fail readiness before queueing when configuration is unusable, preserving D's rules. Also exercise the reported local spawn failure separately so a successful web test cannot hide a broken worker path.

Inspect D/G handoffs and current working tree before editing. Preserve ongoing work; do not change live keys/provider choice during investigation. Link exact test/browser evidence to G1–G6 in the acceptance ledger and append the official handoff to the active execution log. These cases refine existing G requirements, not new acceptance IDs or a separate architecture task.
