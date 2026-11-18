# Director loop v2 (backend)

## Intent

Replace the inferred "no progress" watchdog with a staged Animate run:
explicit stages, a call budget the model can see, delivery judged on the
film by the server. The server owns stage transitions, budgets, gates,
persistence, stopping, recovery and verdicts. Ordinary design runs do not
change.

## Acceptance criteria

- AC-1: an animate card and an ordinary card of the same payer and runner are
  two runs; the ordinary card is not completed by the film.
- AC-2: a model that toggles `edit_frame_html` or `set_composition` A/B from
  its first call ends within `plan + build + one refine` budgets.
- AC-3: 25 identical `animate_storyboard` calls execute once;
  `filmSignature` is equal for two builds that differ only in ids.
- AC-4: saving another editor's film unchanged gives `effective_writes = 0`
  and `failed`. A collaborator's write during the run adds nothing to the
  ledger.
- AC-5: a job that stays `running` for 9 minutes does not stop the run and
  costs at most 6 calls; past 10 minutes the tool says to go on.
- AC-6: 30 distinct effective writes on 5 shots in build are never refused
  for budget.
- AC-7: a stage budget spent with a valid film ends `delivered_with_issues`,
  the card advances, the summary's first line names the open issues.
- AC-8: `generate_voiceover` with `at` omitted, with `at: 0`, and with
  trailing spaces in the text files one job. Two different placements file
  two.
- AC-9: the same scripted run on the API loop and on a fake harness charges
  the same calls; the harness run is aborted `GRACE_CALLS` after the
  ceiling.
- AC-10: ordinary runs keep 24 and 40 turns. A card or a comment that only
  names `animate_storyboard` is an ordinary run.
- AC-11: stop returns at once, status `stopped`, nothing posted. A boot with
  a `running` row marks it `interrupted`.
- AC-12: a last pass with more machine blockers is restored to the best pass
  when the revision is the run's own, and is left alone when somebody else
  wrote.
- AC-13: at a stage boundary on the API path the next model request carries
  exactly one message.
- AC-14: `filmSignature` changes when a keyframe value, time or easing, an
  effect param, `direction` or `motionBlur` changes, and when a shot frame's
  HTML changes.
