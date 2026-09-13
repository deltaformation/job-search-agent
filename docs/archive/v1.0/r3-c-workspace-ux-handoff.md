# R3-C — Expansive workspace UX follow-up

Work order: R3-C — Kanban and card detail UI, user-requested frontend overhaul.

Outcome: Expanded the board to a 1700px canvas with 320px columns, unified search/sort/view controls, Kanban/stacked views, and one global Add Job action. Card details now open in a full-viewport workspace with tailoring, description, and timeline tabs; a context sidebar; selected-version review; artifact access; readable requirement evidence; and explicit review decisions. Source links are keyboard accessible. Nested dialogs retain focus and Escape closes only the top dialog.

Status: needs-review

Files changed in this session:
- `app/board/page.tsx`
- `app/globals.css`
- `components/AppHeader.tsx`
- `components/board/Board.tsx`
- `components/board/BoardColumn.tsx`
- `components/board/JobCard.tsx`
- `components/board/CardDrawer.tsx`
- `components/board/ResumeReview.tsx`
- `components/board/dialog.tsx`
- `tests/unit/components/board/CardDrawer.test.tsx`
- `tests/unit/components/board/workspace-dialog.test.tsx`
- This handoff.

Migrations/data effects: No schema or product data changes. Test runs used their isolated fixtures. Existing unrelated working-tree changes, including tailoring logic and dependencies, were preserved.

Verification performed and exact result:
- Baseline `npm run typecheck`: passed.
- Baseline focused board tests: 6 files / 23 tests passed.
- Final `npm run typecheck`: passed; `npm run lint`: passed with no reported warnings/errors.
- Updated focused board tests plus process tests: 7 files / 30 tests passed.
- `npx vitest run --exclude '**/browser/**'`: 95 files / 652 tests passed.
- New workspace dialog regression test, added afterwards: 1 file / 1 test passed.
- Initial full Vitest attempt: 94 files passed, 3 failed; 651 tests passed, 1 process timeout, 17 browser tests skipped after Chromium sandbox launch failures. The process suite subsequently passed in both focused and non-browser runs.
- Initial E2E attempt could not start its localhost server due to sandbox EPERM. Escalation was declined; user then explicitly requested no browser tests. No subsequent browser execution attempted.
- Vite emits an existing configuration-loader advisory during tests.

Acceptance criteria not yet proven: Browser layout, responsive behavior, pointer/keyboard drag, full approval/application E2E, browser artifact preview/download, and visual QA. User will perform browser verification.

Decisions or deviations: Used the permitted full-viewport overlay option to preserve board state. Existing CardDrawer filename retained for compatibility. Component tests now navigate the timeline tab before checking its contents; assertions retained. Correction opens the timeline so its recorded note is immediately inspectable. Review counts are derived from actual lowercase matched/partial/gap/unsupported statuses, with gaps deduplicated by requirement ID. Board review statistics explicitly refer to loaded cards, avoiding an inaccurate total. Review actions are prominent after evidence instead of a fixed overlay obscuring it. Enter/tab transitions are implemented; no delayed unmount/exit animation. Resume review presentation is included under the explicit mission, with no R4 service or approval-policy edits.

Safety/human checkpoint: Resume approval remains a separate explicit confirmation; application recording remains manual. No real approval, application, or outcome was performed by the agent.

Manual browser checklist:
1. Open Board at desktop and narrow/mobile widths. Verify readable columns, horizontal scrolling, stacked view, search/sort, and one global Add Job action.
2. Open a job with resumes: review should be the default tab. Open one without resumes: description should be the default. Check wide desktop panels and stacked narrow-screen content.
3. Change versions; confirm content, facts, gaps, files, and summary refer to the selected version. Verify PDF/DOCX/Markdown links and preview/download behavior.
4. Switch to Notes & Timeline, add a note, and reload to confirm persistence. Check full description, metadata, source links, and event history.
5. Close with Back to Board or Escape. Confirm focus returns to the card and board search/scroll remain. Open Correct / reopen, press Escape once: only the correction should close; a second Escape closes the workspace.
6. Try pointer dragging and keyboard Space/Arrow/Space reordering, then reload. An unapproved New job must not move to Tailored.
7. On a test job, inspect Approve version then cancel; status must remain unchanged. If intentionally approving, Confirm approval must apply only to that version and move to Tailored.
8. On a test job, verify Apply & Log opens the manual application confirmation. Record only a real/test outcome intentionally; verify timestamp/confirmation persistence and correction/rejection notes.
