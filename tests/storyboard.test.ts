import { describe, expect, it } from 'vitest'
import { analyzeShotHtml, shotNotesIn, storyboardCoverage, STORYBOARD_MAX_PASSES } from '../server/storyboard.ts'
import type { ShotInfo } from '../server/storyboard.ts'
import { hasElementId } from '../server/elementIds.ts'
import type { MotionTrack } from '../shared/motion.ts'

/* The storyboard analysis the animate_storyboard result carries: a shot's
   notes (the elements designers label mouvement / transition / son / voix
   off / notes, or the English words), the notes bar they may share, its
   animatable elements each with a data-doop-id stamped into the frame, and
   the check that reports noted shots still without an element track. */

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
      <span>VOICE-OVER</span><p>a line the narrator reads</p>
    `)
    const notes = shotNotesIn(html)
    expect(notes).toContain('Motion: slow push-in, title words in one by one')
    expect(notes).toContain('Sound: low pad, first beat at 2s')
    /* the bare "VOICE-OVER" label borrows the sibling carrying its text */
    expect(notes.some((n) => n.includes('VOICE-OVER') && n.includes('narrator'))).toBe(true)
  })

  it('reads more of the vocabulary designers use: caméra, narration, audio, dialogue', () => {
    const html = DOC(`
      <p>Caméra : travelling avant</p>
      <p>Mouvement de caméra : panoramique</p>
      <p>Narration : une phrase dite</p>
      <p>Audio : nappe grave</p>
      <p>Bruitage : un déclic</p>
      <p>Dialogue : « tu viens ? »</p>
    `)
    const notes = shotNotesIn(html)
    expect(notes).toContain('Caméra : travelling avant')
    expect(notes).toContain('Mouvement de caméra : panoramique')
    expect(notes).toContain('Narration : une phrase dite')
    expect(notes).toContain('Audio : nappe grave')
    expect(notes).toContain('Bruitage : un déclic')
    expect(notes).toContain('Dialogue : « tu viens ? »')
  })

  it('reads a notes panel labelled by markup, whatever its text', () => {
    const html = DOC('<aside class="shot-notes"><span>fade in, then hold</span></aside><p>not a note</p>')
    expect(shotNotesIn(html)).toEqual(['fade in, then hold'])
  })

  it('treats a bare data-doop-notes marker as a notes panel', () => {
    const html = DOC('<div data-doop-notes><span>whip pan out</span></div>')
    expect(shotNotesIn(html)).toEqual(['whip pan out'])
  })

  it('reads markup panel names on ids and prefixed tokens too', () => {
    const html = DOC(`
      <div id="voix-off"><span>ligne dite</span></div>
      <div class="notes-bottom"><span>autre note</span></div>
      <section class="voice-over-1"><p>dernière ligne</p></section>
    `)
    expect(shotNotesIn(html)).toEqual(['ligne dite', 'autre note', 'dernière ligne'])
  })

  it('accepts a shouted label followed by a spaced dash', () => {
    const html = DOC('<p>VOIX OFF — il était une fois</p><p>SON - nappe grave</p>')
    expect(shotNotesIn(html)).toEqual(['VOIX OFF — il était une fois', 'SON - nappe grave'])
  })

  it('ignores text that only borrows a label word', () => {
    const html = DOC('<p>Le son de la cloche résonne</p><p>notes from the design review</p>')
    /* "Le son…" does not open on a label; "notes…" with a space does not take the colon rule */
    expect(shotNotesIn(html)).toEqual([])
  })
})

describe('shot notes — the false positives that are not notes', () => {
  it('never reads Tailwind or ordinary classes, ids, aria-labels or data-name as notes', () => {
    const html = DOC(`
      <section class="hero transition-all duration-300" id="motion-hero">
        <h1>Travailler seul a ses limites.</h1>
        <button class="btn transition motion-safe:animate-pulse">Go</button>
        <span aria-label="Sound wave" class="dot"></span>
        <div data-name="Notes app mock" class="card sound-card"></div>
      </section>
    `)
    /* the whole design stays design — no note, and the targets are all there */
    expect(shotNotesIn(html)).toEqual([])
    const { targets, notes } = analyzeShotHtml(html)
    expect(notes).toEqual([])
    expect(targets.map((t) => t.tag)).toEqual(expect.arrayContaining(['section', 'h1', 'button']))
  })

  it('never reads headline copy as notes', () => {
    const html = DOC(`
      <h1>Sound. Reimagined.</h1>
      <h2>Motion-first design</h2>
      <p>Note-taking for teams</p>
      <p>Music - everywhere</p>
      <p>Transitions… everywhere</p>
    `)
    expect(shotNotesIn(html)).toEqual([])
  })

  it('never reads a bare label word in design markup as a note', () => {
    const html = DOC(`
      <div class="card"><h3>Notes</h3><p>Write anything down.</p></div>
      <div class="card"><h3>Sound</h3><p>Spatial audio built in.</p></div>
      <div>Transitions</div><p>Smooth by default.</p>
      <ul><li><span>Notes</span><span>Your thoughts…</span></li></ul>
      <a href="/sound">SON</a><p>Audio for all.</p>
      <button>TRANSITION</button><p>Whatever.</p>
      <div><b><span>Notes</span></b><p>Nested too.</p></div>
    `)
    expect(shotNotesIn(html)).toEqual([])
    const { notes, targets, panelId } = analyzeShotHtml(html)
    expect(notes).toEqual([])
    expect(panelId).toBeUndefined()
    expect(targets.length).toBeGreaterThan(0)
  })

  it('still pairs a shouted label or a colon label with the sibling carrying its text', () => {
    const html = DOC(`
      <div>VOIX OFF</div><div>« Et si… »</div>
      <section><span>Notes:</span><p>jot it down</p></section>
    `)
    const notes = shotNotesIn(html)
    expect(notes).toContain('VOIX OFF « Et si… »')
    expect(notes.some((n) => n.includes('Notes:') && n.includes('jot it down'))).toBe(true)
  })

  it('pairs a bare label with its sibling — never with body or the whole frame', () => {
    const html = DOC('<h1>Titre</h1><img src="hero.png"/><div>VOIX OFF</div><div>« Et si… »</div>')
    const notes = shotNotesIn(html)
    /* the note is the pair's text: no headline swallowed, body never promoted */
    expect(notes).toEqual(['VOIX OFF « Et si… »'])
    const { notes: described, targets } = analyzeShotHtml(html)
    expect(described).toHaveLength(1)
    expect(described[0]!.id).toBeTruthy()
    /* and the design elements stay animatable targets */
    expect(targets.map((t) => t.tag)).toEqual(expect.arrayContaining(['h1', 'img']))
  })

  it('reports the whole notes bar as the panel — title row included, never a target', () => {
    const html = DOC(`
      <main>
        <h1>L'accroche visuel</h1>
        <footer>
          <h4>01 · L'accroche 00–04 s</h4>
          <div class="col"><span>VOIX OFF</span><p>il était une fois</p></div>
          <div class="col"><span>MOUVEMENT / TRANSITION / SON</span><p>travelling avant</p></div>
        </footer>
      </main>
    `)
    const notes = shotNotesIn(html)
    expect(notes.some((n) => n.includes('VOIX OFF') && n.includes('il était une fois'))).toBe(true)
    expect(notes.some((n) => n.includes('MOUVEMENT') && n.includes('travelling'))).toBe(true)
    /* the title row is bar furniture, not a note of its own */
    expect(notes.every((n) => !n.includes("L'accroche 00–04"))).toBe(true)

    const { targets, panelId, html: stamped } = analyzeShotHtml(html)
    expect(panelId).toBeTruthy()
    expect(hasElementId(stamped, panelId!)).toBe(true)
    /* nothing inside the bar — not the footer, not the title row, not a
       column — is a target; the design itself (h1, main) stays animatable */
    expect(targets.map((t) => t.tag)).toEqual(['h1', 'main'])
    expect(
      targets.every(
        (t) => t.tag !== 'footer' && t.tag !== 'h4' && t.tag !== 'span' && t.label !== "01 · L'accroche 00–04 s",
      ),
    ).toBe(true)
  })

  it('finds the panel in a flat bar of label spans and sibling paragraphs', () => {
    const html = DOC(`
      <footer>
        <h4>02 · La chute 00:12</h4>
        <span>VOIX OFF</span><p>une ligne dite</p>
        <span>SON</span><p>un battement</p>
      </footer>
    `)
    const { notes, targets, panelId } = analyzeShotHtml(html)
    expect(notes.map((n) => n.text)).toEqual(['VOIX OFF une ligne dite', 'SON un battement'])
    expect(panelId).toBeTruthy()
    expect(targets).toEqual([])
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
    const html = DOC(
      '<script>Math.random()</script><p hidden>secret</p><div style="display:none"><p>ghost</p></div><p>MOTION: in</p>',
    )
    const { targets } = analyzeShotHtml(html)
    expect(targets.every((t) => t.tag !== 'script')).toBe(true)
    expect(targets.every((t) => t.label !== 'secret' && t.label !== 'ghost')).toBe(true)
  })

  it('prioritises headlines and text over wrappers when the cap bites', () => {
    const wrappers = Array.from({ length: 30 }, (_, i) => `<div class="w${i}">x</div>`).join('')
    const html = DOC(`${wrappers}<h1>deep headline</h1>`)
    const { targets } = analyzeShotHtml(html)
    expect(targets.length).toBeLessThanOrEqual(24)
    expect(targets.some((t) => t.tag === 'h1' && t.label.includes('deep headline'))).toBe(true)
  })
})

describe('the coverage check — noted shots vs element tracks', () => {
  const info = (notes: string[], noteIds: string[], elementIds: string[]): ShotInfo => ({
    notes,
    noteIds: new Set(noteIds),
    elementIds: new Set(elementIds),
  })
  const notes = new Map([
    ['f1', info(['MOUVEMENT: travelling avant'], ['note1'], ['el_a1', 'el_b2', 'note1'])],
    ['f2', info(['VOIX OFF: une ligne'], ['note2'], ['el_c3', 'note2'])],
  ])
  const track = (kind: MotionTrack['kind'], frameId?: string, elementId?: string, keyframes = 1, muted?: boolean) => ({
    kind,
    frameId,
    elementId,
    muted,
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

  it('clears a shot once an element track on a real element of its frame has keyframes', () => {
    const coverage = storyboardCoverage([track('camera'), track('element', 'f1', 'el_a1')], notes, 0)
    expect(coverage.animated).toBe(1)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f2'])
  })

  it('says the storyboard is animated when every noted shot is', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 'el_a1'), track('element', 'f2', 'el_c3')], notes, 0)
    expect(coverage.pending).toEqual([])
    expect(coverage.message).toContain('animated')
  })

  it('does not count the opacity-0 track that hides the notes block', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 'note1')], notes, 0)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
  })

  it('does not count a track on an elementId the frame does not carry', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 'el_999')], notes, 0)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
  })

  it('does not count a muted element track', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 'el_a1', 1, true)], notes, 0)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
  })

  it('counts fix passes, then tells the agent to finish and name what is left', () => {
    const last = storyboardCoverage([track('camera')], notes, STORYBOARD_MAX_PASSES)
    expect(last.pass).toBe(STORYBOARD_MAX_PASSES)
    expect(last.message).toContain('finish')
    expect(last.message).toContain('f1')
  })

  it('ignores an element track that carries no keyframes yet', () => {
    const coverage = storyboardCoverage([track('element', 'f1', 'el_a1', 0)], notes, 0)
    expect(coverage.pending.map((p) => p.frameId)).toEqual(['f1', 'f2'])
  })
})
