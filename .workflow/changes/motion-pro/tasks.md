# Implementation tasks

Status: proposed work. Integrate on a feature branch per workstream after approval. Start with the matching regression fixture, stage by explicit path and keep each task independently reviewable. Before any later commit run the repository typecheck, lint, tests and doc-lint. Publication is outside these tasks. Historical implementation checkboxes and their revisions remain available at `cee4509a`; see evidence.md for carried results.

### T1. Reconfirm the director tools

- Status: [ ] open for this revision
- Owner: backend
- Files and interfaces: `server/motionProTools.ts`, `server/motionSnapshot.ts`, `server/guide.ts`, `server/mcp.ts`, `server/resident.ts`
- Implementation: Drive get_scene_snapshot, check_scene, the three preset tools, direction and critique through both registrations. Check a missing renderer and one real image. Check Direction survives reload, all 13 camera presets remain editable, directed beats change shot lengths, and the fifth pass ends the loop.
- Verification: tests/motionPro.test.ts, tests/motionProTools.test.ts, tests/agentToolParity.test.ts.
- Covers: AC 1–7.

### T2. Close the diagnostic gap

- Status: [ ] open for this revision
- Owner: backend
- Files and interfaces: `shared/motionLint.ts`, `shared/motionFx.ts`, `server/motionSnapshot.ts`, `server/mcp.ts`, `server/motionProTools.ts`, `server/resident.ts`
- Implementation: Extend checkScene input with optional candidate_stack: {track_id, effects}. Enforce the same stack size limit as the normal edit path. Collect structured diagnostics for the candidate without invoking a write. Use an existing registry validator for bounds, booleans and enums. Identify unknown_fx (MO-13) and invalid_param (MO-14) in the candidate subsection. Keep stored dangling-lane and undrawn-effect issues in their original section. Document reasons and schema.
- Verification: tests/motionProTools.test.ts and tests/agentToolParity.test.ts: ordinary check, missing track, unknown effect, invalid radius, exact boundary, correct stored costs and unchanged composition revision.
- Covers: AC 2, 7, 8, 11, 17, 18.

### T3. Verify the render and registry baseline

- Status: [ ] open for this revision
- Owner: backend
- Files and interfaces: `shared/motion.ts`, `shared/motionFx.ts`, `shared/motionLooks.ts`, `shared/motionGraph.ts`, `src/lib/motion/gl.ts`, `src/lib/motion/compositor.ts`, `src/pages/MotionRenderHarness.tsx`, `server/motionJobs.ts`, `THIRD-PARTY-LICENSES`
- Implementation: Exercise effect edits and animation lanes, looks, graph handles, blur and cost cap from the same serialized fixture. Compare fixed-time pixels on supported renderer paths; record GL capability and fallback drops. Check license pin and attribution against the notice.
- Verification: tests/motionPro.test.ts, tests/motionProTools.test.ts, tests/motionGoldenBrowser.test.ts: retain seek-path identity, shutter zero and existing golden tolerance.
- Covers: AC 8–18.

### T4. Integrate effect, look and film controls

- Status: [ ] open for this revision
- Owner: frontend
- Files and interfaces: `src/components/motion/MotionTimeline.tsx`, `src/components/motion/MotionProPanel.tsx`, `src/components/motion/EffectCatalog.tsx`, `src/components/motion/EffectStack.tsx`, `src/components/motion/EffectParams.tsx`, `src/components/motion/CostMeter.tsx`, `src/lib/motion/pro.ts`
- Implementation: Port the existing branch components together. Derive field types and options from the registry, edit the selected stack by instance ID, use the shared cap and show reasons on keyboard focus and touch. Test a camera track, adjustment track, missing selection, maximum count and a disabled stack. Verify looks, film shutter and direction edits by reopening the page.
- Verification: tests/motionEffectStack.test.tsx, tests/motionProUi.test.ts: find the persisted effect, animated param, look track and refusal reason.
- Covers: AC 9, 13, 17, 19, 23.

### T5. Preserve concurrent work and undo

- Status: [ ] open for this revision
- Owner: frontend
- Files and interfaces: `src/lib/motion/sendOps.ts`, `src/lib/motion/pro.ts`, `src/lib/history.ts`, `src/lib/motion/store.ts`
- Implementation: Serialize page edits. Use the current revision for every send and retry one 409 after reload. Re-resolve operations by ID. A removed target cannot redirect an edit to its neighbor. Coalesce one field burst, preserve its initial inverse, and flush before another action. On final failure keep the history entry. Undo camera creation by removing the added effect only; restore beats against the latest direction.
- Verification: tests/motionProUndo.test.ts: a second writer keys the camera, edits treatment or deletes the target; exercise a second 409, repeated arrow keys and a failed undo followed by retry.
- Covers: AC 21, 22.

### T6. Repeat panel and documentation review

- Status: [ ] open for this revision
- Owner: frontend
- Files and interfaces: `src/components/motion/MotionTimeline.tsx`, `src/components/motion/MotionProPanel.tsx`, `src/components/motion/WithReason.tsx`, `src/lib/motion/labels.ts`, `src/lib/i18n/en/motionPro.ts`, `src/lib/i18n/pt-BR/motionPro.ts`, `docs/motion-api.md`, `docs/motion-fx.md`, `docs/TECHSTACK.md`
- Implementation: Inspect all twelve review findings. Open the real canvas with both sidebars, ten effects and a multi-line beat. Inspect each tab, key repeat, undo notice, visible meter and translated registry text. Remove confirmed unused helpers after checking callers. Record the revision, images, locale and dimensions.
- Verification: tests/motionProPanelBrowser.test.ts and tests/motionProUi.test.ts: 1280/1440, both languages/themes, independent scroll positions and readable ruler. Run all affected tests, parity, typecheck, lint and doc-lint..
- Covers: AC 18–24.

## Coverage

| Criterion | Tasks      |
| --------- | ---------- |
| AC-1      | T1         |
| AC-2      | T1, T2     |
| AC-3      | T1         |
| AC-4      | T1         |
| AC-5      | T1         |
| AC-6      | T1         |
| AC-7      | T1, T2     |
| AC-8      | T2, T3     |
| AC-9      | T3, T4     |
| AC-10     | T3         |
| AC-11     | T2, T3     |
| AC-12     | T3         |
| AC-13     | T3, T4     |
| AC-14     | T3         |
| AC-15     | T3         |
| AC-16     | T3         |
| AC-17     | T2, T3, T4 |
| AC-18     | T2, T3, T6 |
| AC-19     | T4, T6     |
| AC-20     | T6         |
| AC-21     | T5, T6     |
| AC-22     | T5, T6     |
| AC-23     | T4, T6     |
| AC-24     | T6         |
