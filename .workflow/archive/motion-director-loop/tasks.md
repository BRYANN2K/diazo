# Tasks — motion-director-loop (M0-BE)

- [x] 0. Change folder (proposal, spec, tasks, state)
- [x] 1. Animate card kind + `AnimateRequest` + card-route validation; UI sends kind + page (cherry-pick e379a91 extended)
- [x] 2. `shared/director.ts` types + pure logic; `shared/canonicalJson.ts` added (absent on base)
- [x] 3. Isolation in `server/actions.ts`: `nextWork`, `takeAnimateCard`, feedback → refine card
- [x] 4. `server/directorRuns.ts`: run store, persistence, room broadcast
- [x] 5. Migration 0085 `director_runs` + `schema.ts` + `persist.ts` (0083/0084 left free)
- [x] 6. `server/directorLoop.ts` `runDirector` + `resident.ts` wiring (`end_stage`, `wait_for_job`)
- [x] 7. Paid `effectiveKey` on speech / video / render / blender tools
- [x] 8. `critique_scene` scores/issues + `machineRubric`; MCP `wait_for_job`; `guide.ts` DIRECTOR
- [x] 9. Routes: list/get/stop director runs (views, no ledger)
- [x] 10. Tests: director, directorRun, directorHttp, agentToolParity, storyboardAgent
- [x] 11. Docs + evidence + checks
- [ ] 12. Conventional commits; push -u origin feat/motion-director-loop
