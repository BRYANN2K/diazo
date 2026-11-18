# Evidence

Subject: `8c4e7e35ab9f89f5f699e8cc693cc25cafee743967d7c600323efee393a47087`

- AC-1: passed — takeQueuedCardsFor never returns animate cards; takeAnimateCard claims one and a second card waits on a busy page — tests/directorRun.test.ts 'queue isolation'
- AC-2: passed — set_composition A/B from the first call ends within plan 10 + build 28 + one refine 18 (57 calls) — tests/directorRun.test.ts 'an A/B toggle loop'
- AC-3: passed — 25 identical animate_storyboard calls execute once, 24 repeat refusals; filmSignature equal across regenerated ids — tests/directorRun.test.ts + tests/director.test.ts
- AC-4: passed — unchanged save → effectiveWrites 0 and failed 'no effective write'; ledger keys the call's own target — tests/directorRun.test.ts 'a no-op film save'
- AC-5: passed — six 90s wait_for_job calls on a running job cost 6 calls and don't stop the run; past WAIT_JOB_MS it says go on without it — tests/directorRun.test.ts 'wait_for_job'
- AC-6: passed — 30 distinct set_composition writes on five shots in build: zero refusals, all effective — tests/directorRun.test.ts '30 distinct effective writes'
- AC-7: passed — plan budget spent with a valid film → delivered_with_issues, card advances, summary starts 'Open issues:' — tests/directorRun.test.ts
- AC-8: passed — voiceover at omitted / at 0 / trailing-space text file one job; at 2 files a second — tests/directorRun.test.ts 'equivalent voice-over filings'
- AC-9: passed — same script on API loop and fake harness charges identical spent.calls; harness aborted GRACE_CALLS past the ceiling — tests/directorRun.test.ts 'run ceiling'
- AC-10: passed — MAX_TURNS 24 and redesign 40 untouched; a card naming animate_storyboard without the kind claims as ordinary — tests/directorRun.test.ts queue isolation
- AC-11: passed — stopCard → status stopped, nothing posted; a running row at boot → interrupted and card fails — tests/directorRun.test.ts; routes in tests/directorHttp.test.ts
- AC-12: passed — last pass with more blockers restores best pass's version only while revision is the run's own — tests/directorRun.test.ts 'composition regression restore'
- AC-13: passed — each stage's first model request carries exactly one message — tests/directorRun.test.ts fresh run
- AC-14: passed — filmSignature changes on keyframe value/time/easing, effect param, direction, motionBlur and shot HTML — tests/director.test.ts
