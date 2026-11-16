import { describe, expect, it } from 'vitest'
import { analyzeShotHtml, shotNotesIn, storyboardCoverage, STORYBOARD_MAX_PASSES } from '../server/storyboard.ts'
import { hasElementId } from '../server/elementIds.ts'
import type { MotionTrack } from '../shared/motion.ts'

/* The storyboard analysis the animate_storyboard result carries: a shot's
   notes (the elements designers label mouvement / transition / son / voix
   off / notes, or the English words), its animatable elements each with a
   data-doop-id stamped into the frame, and the check that reports noted
   shots still without an element track. */

const DOC = (body: string) => `<!doctype html><html><body>${body}</body></html>`

const BRYAN = DOC(`
  <div class="shot">
    <h1>Séquence 01 — Ouverture</h1>
    <img src="hero.png" alt="Le studio"/>
    <p>MOUVEMENT / TRANSITION / SON : travelling avant lent ; mots en apparition, pulsation orange vers 02 … Son : nappe grave et premier battement</p>
    <p>VOIX OFF : il était une fois un studio qui dessinait le silence</p>
    <button class="cta">Commencer</button>
  </div>
`)

describe('shot notes — what the frame tells the agent', () => {
  it('extracts French labels: mouvement, transition, son and voix off', () => {
    const notes = shotNotesIn(BRYAN)
    expect(notes.some((n) => n.includes('MOUVEMENT') && n.includes('travelling avant lent'))).toBe(true)
    expect(notes.some((n) => n.includes('VOIX OFF') && n.includes('studio'))).toBe(true)
  })

  it('extracts English labels: motion, sound and voice-over', () => {
    const html = DOC(`
      <p>Motion: slow push-in, title words in one by one</p>
      <p>Sound: low pad, first beat at 2s</p>
      <h3>Voice-over</h3><p>a line the narrator reads</p>
    `)
    const notes = shotNotesIn(html)
    expect(notes).toContain('Motion: slow push-in, title words in one by one')
    expect(notes).toContain('Sound: low pad, first beat at 2s')
    /* the bare "Voice-over" heading borrows the block that carries its text */
    expect(notes.some((n) => n.includes('Voice-over') && n.includes('narrator'))).toBe(true)
  })

  it('reads a notes panel labelled by markup, whatever its text', () => {
    const html = DOC('<aside class="shot-notes"><span>fade in, then hold</span></aside><p>not a note</p>')
    expect(shotNotesIn(html)).toEqual(['fade in, then hold'])
  })

  it('treats a bare data-doop-notes marker as a notes panel', () => {
    const html = DOC('<div data-doop-notes><span>whip pan out</span></div>')
    expect(shotNotesIn(html)).toEqual(['whip pan out'])
  })

  it('ignores text that only borrows a label word', () => {
    const html = DOC('<p>Le son de la cloche résonne</p><p>notes from the design review</p>')
    /* "Le son…" does not open on a label; "notes…" with a space does not take the colon rule */
    expect(shotNotesIn(html)).toEqual([])
  })
})

describe('animatable targets and id stamping', () => {
  it('lists headlines, text, images and key UI with a data-doop-id each', () => {
    const { targets, notes, html, stampedIds } = analyzeShotHtml(BRYAN)
    const tags = targets.map((t) => t.tag)
    expect(tags).toContain('h1')
    expect(tags).toContain('img')
    expect(tags).toContain('button')
    expect(tags).toContain('div') // .shot — the layer a parallax moves
    for (const target of targets) expect(hasElementId(html, target.id)).toBe(true)
    /* notes blocks are stamped too — the agent hides the notes layer by id */
    for (const note of notes) {
      expect(note.id).toBeTruthy()
      expect(hasElementId(html, note.id!)).toBe(true)
    }
    expect(stampedIds.length).toBeGreaterThan(0)
    /* and no note element leaks into the target list */
    const noteIds = new Set(notes.map((n) => n.id))
    expect(targets.every((t) => !noteIds.has(t.id))).toBe(true)
  })

  it('keeps ids a frame already carries instead of stamping over them', () => {
    const html = DOC('<h1 data-doop-id="a1b2c3">Titre</h1><p>MOTION: fade in</p>')
    const { targets } = analyzeShotHtml(html)
    expect(targets.find((t) => t.tag === 'h1')?.id).toBe('a1b2c3')
  })

  it('never returns a script, a style or a hidden element as a target', () => {
    const html = DOC('<script>Math.random()</script><p hidden>secret</p><p>MOTION: in</p>')
    const { targets } = analyzeShotHtml(html)
    expect(targets.every((t) => t.tag !== 'script')).toBe(true)
    expect(targets.every((t) => t.label !== 'secret')).toBe(true)
  })
})

describe('the coverage check — noted shots vs element tracks', () => {
  const notes = new Map([
    ['f1', ['MOUVEMENT: travelling avant']],
    ['f2', ['VOIX OFF: une ligne']],
  ])
  const track = (kind: MotionTrack['kind'], frameId?: string, keyframes = 1) => ({
    kind,
    frameId,
    keyframes: Array.from({ length: keyframes }, (_, i) => ({
      id: `k${i}`,
      property: 'opacity',
      t: 0,
      value: 0,
      easing: { type: 'linear' as const },
    })),
  })

  it('reports every noted shot still without an element track', () => {
    const coverage = storyboardCoverage([track('camera')], notes, 0)
    expect(coverage).toMatchObject({ noted: 2, animated: 0 })
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
    expect(coverage.message).toContain('element track')
  })

  it('clears a shot once an element track on its frame has keyframes', () => {
    const coverage = storyboardCoverage([track('camera'), track('element', 'f1')], notes, 0)
    expect(coverage.animated).toBe(1)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f2'])
  })

  it('says the storyboard is animated when every noted shot is', () => {
    const coverage = storyboardCoverage([track('element', 'f1'), track('element', 'f2')], notes, 0)
    expect(coverage.pending).toEqual([])
    expect(coverage.message).toContain('animated')
  })

  it('counts fix passes, then tells the agent to finish and name what is left', () => {
    const last = storyboardCoverage([track('camera')], notes, STORYBOARD_MAX_PASSES)
    expect(last.pass).toBe(STORYBOARD_MAX_PASSES)
    expect(last.message).toContain('finish')
    expect(last.message).toContain('f1')
  })

  it('ignores an element track that carries no keyframes yet', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 0)], notes, 0)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
  })
})
