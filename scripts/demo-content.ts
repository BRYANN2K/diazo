/**
 * The README demo's content: "Fieldnote", an invented SaaS for teams that
 * run user interviews. Frames, a UI kit, tokens, a skill and a small repo,
 * all made up, for scripts/seed-demo.ts. Nothing here is real data.
 */

export const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">'

/** The canvas's design tokens (the repo's copy differs on purpose: see REPO_FILES). */
export const TOKENS = [
  { name: 'fn-green', type: 'color', value: '#2f6b4f' },
  { name: 'fn-green-soft', type: 'color', value: '#e3efe8' },
  { name: 'fn-ink', type: 'color', value: '#1c211f' },
  { name: 'fn-ink-soft', type: 'color', value: '#5b635f' },
  { name: 'fn-paper', type: 'color', value: '#faf8f3' },
  { name: 'fn-line', type: 'color', value: '#e6e2d8' },
  { name: 'fn-amber', type: 'color', value: '#e9a23b' },
  { name: 'fn-radius', type: 'radius', value: '10px' },
  { name: 'fn-space', type: 'spacing', value: '16px' },
] as const

const ROOT = `:root{--fn-green:#2f6b4f;--fn-green-soft:#e3efe8;--fn-ink:#1c211f;--fn-ink-soft:#5b635f;--fn-paper:#faf8f3;--fn-line:#e6e2d8;--fn-amber:#e9a23b;--fn-radius:10px;--fn-space:16px}`
const RESET = `*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,sans-serif;color:var(--fn-ink);background:var(--fn-paper);-webkit-font-smoothing:antialiased}.btn,.solid{background-image:linear-gradient(transparent,transparent)!important}`

function doc(body: string, css = '', bodyAttrs = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINK}<style>${ROOT}${RESET}${css}</style></head><body${bodyAttrs}>${body}</body></html>`
}

const LOGO = `<span style="display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:18px;letter-spacing:-.01em"><span class="solid" style="width:26px;height:26px;border-radius:8px;background:var(--fn-green);display:inline-grid;place-items:center;color:#fff;font-size:14px">f</span>Fieldnote</span>`

const NAV = `<nav style="display:flex;align-items:center;justify-content:space-between;padding:22px 72px">${LOGO}<div style="display:flex;gap:32px;font-size:15px;color:var(--fn-ink-soft)"><a>Product</a><a>Templates</a><a>Pricing</a><a>Customers</a></div><div style="display:flex;gap:12px;align-items:center"><a style="font-size:15px;color:var(--fn-ink-soft)">Sign in</a><a class="btn">Start free</a></div></nav>`

const BTN = `.btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;border-radius:var(--fn-radius);background:var(--fn-green);color:#fff;font-weight:600;font-size:15px;text-decoration:none}.btn.ghost{background:transparent;color:var(--fn-ink);box-shadow:inset 0 0 0 1px var(--fn-line)}a{color:inherit;text-decoration:none}`

function noteCard(title: string, who: string, tags: string[], quote: string): string {
  return `<div style="background:#fff;border:1px solid var(--fn-line);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:15px">${title}</strong><span style="font-size:12px;color:var(--fn-ink-soft)">${who}</span></div><p style="font-size:14px;line-height:1.5;color:var(--fn-ink-soft)">“${quote}”</p><div style="display:flex;gap:6px">${tags.map((t) => `<span style="font-size:12px;padding:3px 9px;border-radius:99px;background:var(--fn-green-soft);color:var(--fn-green);font-weight:500">${t}</span>`).join('')}</div></div>`
}

export const LANDING = doc(
  `${NAV}<main style="display:grid;grid-template-columns:1.05fr 1fr;gap:56px;padding:64px 72px 0;align-items:center">
<div><span style="display:inline-block;font-size:13px;font-weight:600;color:var(--fn-green);background:var(--fn-green-soft);padding:6px 12px;border-radius:99px">New · AI tags for every interview</span>
<h1 style="font-size:64px;line-height:1.04;letter-spacing:-.035em;margin:22px 0 20px;font-weight:700">Every customer interview, searchable by Monday.</h1>
<p style="font-size:19px;line-height:1.55;color:var(--fn-ink-soft);max-width:520px">Fieldnote records, transcribes and tags your research calls, then turns them into a board your whole team can read.</p>
<div style="display:flex;gap:12px;margin-top:32px"><a class="btn">Start free</a><a class="btn ghost">Watch a 2-minute tour</a></div>
<p style="margin-top:28px;font-size:13px;color:var(--fn-ink-soft)">Used by research teams at 1,200 product companies</p></div>
<div style="background:linear-gradient(160deg,#e3efe8,#f4ead7);border-radius:24px;padding:28px;display:grid;gap:14px">
${noteCard('Onboarding call — Priya', 'Tue 14:00', ['Pricing', 'Setup'], 'We almost gave up during setup. The import step asked for things we did not have yet.')}
${noteCard('Churn interview — Marco', 'Mon 10:30', ['Churn', 'Exports'], 'Our analysts live in spreadsheets. Without a CSV export it never stuck.')}
${noteCard('Discovery — Lena', 'Fri 16:15', ['Mobile'], 'I take notes on my phone between site visits, so it has to work one-handed.')}
</div></main>`,
  BTN,
)

function tier(name: string, price: string, blurb: string, items: string[], featured = false): string {
  return `<div class="solid" style="background:${featured ? 'var(--fn-ink)' : '#fff'};color:${featured ? '#fff' : 'var(--fn-ink)'};border:1px solid ${featured ? 'var(--fn-ink)' : 'var(--fn-line)'};border-radius:18px;padding:30px;display:flex;flex-direction:column;gap:18px">
<div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:18px">${name}</strong>${featured ? '<span style="font-size:12px;font-weight:600;background:var(--fn-amber);color:var(--fn-ink);padding:4px 10px;border-radius:99px">Most teams</span>' : ''}</div>
<div><span style="font-size:44px;font-weight:700;letter-spacing:-.03em">${price}</span><span style="opacity:.7"> / seat / month</span></div>
<p style="font-size:15px;line-height:1.5;opacity:.75">${blurb}</p>
<a class="btn" style="justify-content:center;${featured ? 'background:#fff;color:var(--fn-ink)' : ''}">Choose ${name}</a>
<ul style="list-style:none;padding:0;display:grid;gap:10px;font-size:14px">${items.map((i) => `<li style="display:flex;gap:10px"><span style="color:${featured ? 'var(--fn-amber)' : 'var(--fn-green)'}">✓</span>${i}</li>`).join('')}</ul></div>`
}

export const PRICING = doc(
  `${NAV}<section style="padding:56px 72px;text-align:center"><h1 style="font-size:52px;letter-spacing:-.03em;font-weight:700">Pricing that grows with your research</h1>
<p style="font-size:18px;color:var(--fn-ink-soft);margin-top:14px">Free for your first 10 interviews. No credit card.</p>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:48px;text-align:left">
${tier('Starter', '$0', 'For a researcher trying Fieldnote on a real project.', ['10 interviews a month', 'Transcripts in 30 languages', 'One shared board'])}
${tier('Team', '$24', 'For product teams that interview every week.', ['Unlimited interviews', 'AI tags and highlight reels', 'Slack and Linear sync', 'Roles and guest access'], true)}
${tier('Enterprise', 'Custom', 'For research ops across several teams.', ['SSO and SCIM', 'Data residency in the EU', 'Audit log', 'A named research partner'])}
</div></section>`,
  BTN,
)

const SIDEBAR = `<aside style="width:240px;border-right:1px solid var(--fn-line);padding:22px 16px;display:flex;flex-direction:column;gap:4px;background:#fff">${LOGO}<div style="height:22px"></div>${['Interviews', 'Insights', 'Highlight reels', 'Tags', 'Team', 'Settings'].map((n, i) => `<a style="padding:9px 12px;border-radius:8px;font-size:14px;${i === 0 ? 'background:var(--fn-green-soft);color:var(--fn-green);font-weight:600' : 'color:var(--fn-ink-soft)'}">${n}</a>`).join('')}</aside>`

function stat(label: string, value: string, delta: string): string {
  return `<div style="background:#fff;border:1px solid var(--fn-line);border-radius:14px;padding:18px 20px"><div style="font-size:13px;color:var(--fn-ink-soft)">${label}</div><div style="font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:6px">${value}</div><div style="font-size:12px;color:var(--fn-green);margin-top:4px;font-weight:500">${delta}</div></div>`
}

function row(name: string, who: string, date: string, tags: string, status: string): string {
  return `<tr><td style="padding:14px 16px;font-weight:500">${name}</td><td style="padding:14px 16px;color:var(--fn-ink-soft)">${who}</td><td style="padding:14px 16px;color:var(--fn-ink-soft)">${date}</td><td style="padding:14px 16px">${tags}</td><td style="padding:14px 16px"><span style="font-size:12px;padding:3px 9px;border-radius:99px;background:${status === 'Tagged' ? 'var(--fn-green-soft);color:var(--fn-green)' : '#f6ecd9;color:#8a5a12'};font-weight:500">${status}</span></td></tr>`
}

export const DASHBOARD = doc(
  `<div style="display:flex;height:100vh">${SIDEBAR}<main style="flex:1;padding:28px 36px;display:flex;flex-direction:column;gap:22px">
<div style="display:flex;justify-content:space-between;align-items:center"><div><h1 style="font-size:26px;letter-spacing:-.02em">Interviews</h1><p style="font-size:14px;color:var(--fn-ink-soft);margin-top:4px">Q4 onboarding study · 38 calls</p></div><a class="btn">New interview</a></div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">${stat('Interviews this month', '38', '+12 vs September')}${stat('Hours transcribed', '41.5', '+9.2 h')}${stat('Insights filed', '126', '+31')}${stat('Open questions', '7', '3 answered this week')}</div>
<div style="background:#fff;border:1px solid var(--fn-line);border-radius:14px;overflow:hidden"><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="text-align:left;color:var(--fn-ink-soft);font-size:12px;background:#fbfaf6"><th style="padding:12px 16px;font-weight:500">Interview</th><th style="padding:12px 16px;font-weight:500">With</th><th style="padding:12px 16px;font-weight:500">Date</th><th style="padding:12px 16px;font-weight:500">Tags</th><th style="padding:12px 16px;font-weight:500">Status</th></tr></thead><tbody>
${row('Onboarding call', 'Priya Raman, Northwind', 'Nov 11', 'Pricing · Setup', 'Tagged')}
${row('Churn interview', 'Marco Bellini, Atlas Freight', 'Nov 10', 'Churn · Exports', 'Tagged')}
${row('Discovery', 'Lena Vogt, Brightside', 'Nov 7', 'Mobile', 'Tagged')}
${row('Usability test #4', 'Sam Okafor, Lumen Labs', 'Nov 6', '—', 'Transcribing')}
${row('Pricing survey follow-up', 'Ana Duarte, Tidepool', 'Nov 4', 'Pricing', 'Tagged')}
</tbody></table></div></main></div>`,
  BTN,
)

/* deliberately imperfect for the frame checks: 32px icon buttons and a pale caption */
export const MOBILE = doc(
  `<header style="display:flex;justify-content:space-between;align-items:center;padding:52px 20px 12px"><button style="width:32px;height:32px;border-radius:8px;border:1px solid var(--fn-line);background:#fff">‹</button><strong style="font-size:16px">Interview notes</strong><button style="width:32px;height:32px;border-radius:8px;border:1px solid var(--fn-line);background:#fff">⋯</button></header>
<section style="padding:8px 20px;display:grid;gap:14px"><div><h1 style="font-size:24px;letter-spacing:-.02em">Discovery — Lena</h1><p style="font-size:12px;color:#c9c5bb;margin-top:4px">Recorded Fri 16:15 · 42 min · Brightside</p></div>
<div style="display:flex;gap:6px"><span style="font-size:12px;padding:4px 10px;border-radius:99px;background:var(--fn-green-soft);color:var(--fn-green);font-weight:500">Mobile</span><span style="font-size:12px;padding:4px 10px;border-radius:99px;background:#f6ecd9;color:#8a5a12;font-weight:500">Field work</span></div>
${noteCard('Highlight 1', '03:12', ['Mobile'], 'I take notes on my phone between site visits, so it has to work one-handed.')}
${noteCard('Highlight 2', '17:40', ['Sync'], 'When I get back to the office the notes should already be on the board.')}
<a class="btn" style="justify-content:center;margin-top:6px">Add a highlight</a></section>`,
  BTN,
)

/* -------------------------------------------------------------------- */
/* the UI kit (a design library): `<id> — <label>` names, marked variants */
/* -------------------------------------------------------------------- */

const SHEET_CSS = `${BTN}body{padding:40px;background:#fff}.sheet{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start}.cell{display:flex;flex-direction:column;gap:12px;align-items:flex-start}.cap{font-size:12px;color:var(--fn-ink-soft);font-weight:500}`

function sheet(category: string, cells: [id: string, label: string, html: string][]): string {
  return doc(
    `<div class="sheet">${cells.map(([id, label, html]) => `<div class="cell" data-doop-variant="${id}" data-doop-name="${label}">${html}<span class="cap">${label}</span></div>`).join('')}</div>`,
    SHEET_CSS,
    ` data-doop-category="${category}"`,
  )
}

const input = (state: string, border: string, help = '') =>
  `<label style="display:grid;gap:6px;width:260px;font-size:13px;font-weight:500">Workspace name<input aria-label="Workspace name" value="${state === 'empty' ? '' : 'Northwind research'}" placeholder="e.g. Acme research" style="height:44px;border-radius:var(--fn-radius);border:1px solid ${border};padding:0 14px;font:inherit;font-weight:400;font-size:15px${state === 'focus' ? ';box-shadow:0 0 0 3px var(--fn-green-soft)' : ''}">${help}</label>`

function settingRow(title: string, detail: string, on: boolean): string {
  const knob = on ? 'right:3px' : 'left:3px'
  return `<div style="width:340px;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 18px;border:1px solid var(--fn-line);border-radius:14px;background:#fff"><span style="display:grid;gap:3px"><strong style="font-size:14px">${title}</strong><span style="font-size:13px;color:var(--fn-ink-soft)">${detail}</span></span><span class="solid" style="flex:none;display:inline-block;width:44px;height:26px;border-radius:99px;background:${on ? 'var(--fn-green)' : '#dcd8cd'};position:relative"><span style="position:absolute;${knob};top:3px;width:20px;height:20px;border-radius:99px;background:#fff"></span></span></div>`
}

function searchField(value: string, open: boolean): string {
  const results = open
    ? `<div style="border-top:1px solid var(--fn-line);padding:8px;display:grid;gap:2px;font-size:13px">${['Pricing survey follow-up · Ana Duarte', 'Onboarding call · Priya Raman', 'Churn interview · Marco Bellini'].map((r, i) => `<span style="padding:7px 10px;border-radius:8px;${i === 0 ? 'background:var(--fn-green-soft)' : ''}">${r}</span>`).join('')}</div>`
    : ''
  return `<div style="width:320px;border:1px solid ${open ? 'var(--fn-green)' : 'var(--fn-line)'};border-radius:12px;background:#fff;overflow:hidden"><div style="display:flex;align-items:center;gap:10px;height:44px;padding:0 14px;font-size:15px;color:${open ? 'var(--fn-ink)' : 'var(--fn-ink-soft)'}"><span>⌕</span><span style="flex:1">${value}</span><span style="font-size:12px;padding:2px 6px;border-radius:6px;background:#f2efe7;color:var(--fn-ink-soft)">⌘K</span></div>${results}</div>`
}

export const KIT: { name: string; width: number; height: number; html: string }[] = [
  {
    name: 'cp.button — Button',
    width: 720,
    height: 200,
    html: sheet('Components/Buttons', [
      ['cp.button-primary', 'Primary', '<a class="btn">Start free</a>'],
      ['cp.button-secondary', 'Secondary', '<a class="btn ghost">Watch the tour</a>'],
      ['cp.button-danger', 'Danger', '<a class="btn" style="background:#b4412f">Delete interview</a>'],
      ['cp.button-small', 'Small', '<a class="btn" style="height:34px;padding:0 14px;font-size:13px">Tag</a>'],
    ]),
  },
  {
    name: 'cp.field — Text field',
    width: 900,
    height: 220,
    html: sheet('Components/Inputs', [
      ['cp.field-default', 'Default', input('default', 'var(--fn-line)')],
      ['cp.field-focus', 'Focus', input('focus', 'var(--fn-green)')],
      [
        'cp.field-error',
        'Error',
        input(
          'error',
          '#b4412f',
          '<span style="color:#b4412f;font-weight:400;font-size:12px">This name is taken</span>',
        ),
      ],
    ]),
  },
  {
    name: 'cp.tag — Tag',
    width: 560,
    height: 160,
    html: sheet('Components/Badges', [
      [
        'cp.tag-green',
        'Topic',
        '<span style="font-size:13px;padding:4px 11px;border-radius:99px;background:var(--fn-green-soft);color:var(--fn-green);font-weight:500">Pricing</span>',
      ],
      [
        'cp.tag-amber',
        'Pending',
        '<span style="font-size:13px;padding:4px 11px;border-radius:99px;background:#f6ecd9;color:#8a5a12;font-weight:500">Transcribing</span>',
      ],
      [
        'cp.tag-outline',
        'Outline',
        '<span style="font-size:13px;padding:4px 11px;border-radius:99px;box-shadow:inset 0 0 0 1px var(--fn-line);font-weight:500">Draft</span>',
      ],
    ]),
  },
  {
    name: 'cp.note-card — Interview card',
    width: 860,
    height: 260,
    html: sheet('Components/Cards', [
      [
        'cp.note-card-default',
        'Default',
        `<div style="width:360px">${noteCard('Onboarding call — Priya', 'Tue 14:00', ['Pricing', 'Setup'], 'We almost gave up during setup.')}</div>`,
      ],
      [
        'cp.note-card-compact',
        'Compact',
        `<div style="width:300px">${noteCard('Churn — Marco', 'Mon', ['Churn'], 'Without a CSV export it never stuck.')}</div>`,
      ],
    ]),
  },
  {
    name: 'cp.stat — Stat card',
    width: 760,
    height: 200,
    html: sheet('Components/Cards', [
      [
        'cp.stat-default',
        'Default',
        `<div style="width:200px">${stat('Interviews this month', '38', '+12 vs September')}</div>`,
      ],
      ['cp.stat-hours', 'Hours', `<div style="width:200px">${stat('Hours transcribed', '41.5', '+9.2 h')}</div>`],
      ['cp.stat-insights', 'Insights', `<div style="width:200px">${stat('Insights filed', '126', '+31')}</div>`],
    ]),
  },
  {
    name: 'cp.tabs — Tabs',
    width: 640,
    height: 160,
    html: sheet('Components/Navigation', [
      [
        'cp.tabs-underline',
        'Underline',
        `<div style="display:flex;gap:24px;border-bottom:1px solid var(--fn-line);font-size:14px">${['Transcript', 'Highlights', 'Tags'].map((t, i) => `<span style="padding:10px 0;${i === 0 ? 'border-bottom:2px solid var(--fn-green);font-weight:600' : 'color:var(--fn-ink-soft)'}">${t}</span>`).join('')}</div>`,
      ],
      [
        'cp.tabs-pill',
        'Pill',
        `<div style="display:flex;gap:4px;padding:4px;background:#f2efe7;border-radius:12px;font-size:14px">${['Week', 'Month', 'Quarter'].map((t, i) => `<span style="padding:7px 14px;border-radius:9px;${i === 1 ? 'background:#fff;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)' : 'color:var(--fn-ink-soft)'}">${t}</span>`).join('')}</div>`,
      ],
    ]),
  },
  {
    name: 'cp.toggle — Setting row',
    width: 820,
    height: 200,
    html: sheet('Components/Inputs', [
      ['cp.toggle-on', 'On', settingRow('Weekly digest', 'Email the board summary every Monday', true)],
      ['cp.toggle-off', 'Off', settingRow('Guest access', 'Let invited guests read the board', false)],
    ]),
  },
  {
    name: 'bk.pricing — Pricing table',
    width: 1200,
    height: 640,
    html: doc(
      `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px">${tier('Starter', '$0', 'For a first project.', ['10 interviews a month', 'Transcripts'])}${tier('Team', '$24', 'For weekly research.', ['Unlimited interviews', 'AI tags', 'Slack sync'], true)}${tier('Enterprise', 'Custom', 'For research ops.', ['SSO', 'Audit log'])}</div>`,
      `${BTN}body{padding:40px}`,
      ' data-doop-category="Sections/Pricing"',
    ),
  },
  {
    name: 'hero.split — Split hero',
    width: 1200,
    height: 620,
    html: doc(
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center"><div><h1 style="font-size:48px;line-height:1.05;letter-spacing:-.03em">Every interview, searchable by Monday.</h1><p style="font-size:17px;color:var(--fn-ink-soft);margin:18px 0 26px;line-height:1.5">Record, transcribe and tag research calls in one place.</p><a class="btn">Start free</a></div><div style="background:linear-gradient(160deg,#e3efe8,#f4ead7);border-radius:20px;padding:22px;display:grid;gap:12px">${noteCard('Onboarding call', 'Tue', ['Setup'], 'The import step asked for things we did not have yet.')}${noteCard('Discovery', 'Fri', ['Mobile'], 'It has to work one-handed.')}</div></div>`,
      `${BTN}body{padding:48px}`,
      ' data-doop-category="Sections/Heroes"',
    ),
  },
  {
    name: 'cp.search — Search field',
    width: 760,
    height: 200,
    html: sheet('Components/Inputs', [
      ['cp.search-default', 'Default', searchField('Search interviews', false)],
      ['cp.search-active', 'With results', searchField('pricing objections', true)],
    ]),
  },
  {
    name: 'bk.faq — FAQ',
    width: 900,
    height: 520,
    html: doc(
      `<h2 style="font-size:32px;letter-spacing:-.02em;margin-bottom:20px">Questions</h2>${['Can I import recordings from Zoom?', 'Which languages are transcribed?', 'Where is my data stored?', 'Can guests see the board?'].map((q, i) => `<div style="border-top:1px solid var(--fn-line);padding:18px 0"><div style="display:flex;justify-content:space-between;font-weight:600;font-size:17px">${q}<span>${i === 0 ? '−' : '+'}</span></div>${i === 0 ? '<p style="color:var(--fn-ink-soft);margin-top:10px;line-height:1.5">Yes. Connect Zoom once and every cloud recording lands in Fieldnote with its transcript.</p>' : ''}</div>`).join('')}`,
      'body{padding:48px}',
      ' data-doop-category="Sections/FAQ"',
    ),
  },
]

/* -------------------------------------------------------------------- */
/* the curation sources: two older, messy kits with duplicates between    */
/* -------------------------------------------------------------------- */

const block = (title: string, body: string) =>
  doc(
    `<div style="min-height:100vh;display:grid;place-content:center;justify-items:center;gap:18px;padding:32px;text-align:center"><h3 style="font-size:34px;letter-spacing:-.02em">${title}</h3>${body}</div>`,
    `${BTN}input{height:44px;width:320px;border-radius:10px;border:1px solid var(--fn-line);padding:0 14px;font:inherit}`,
  )

export const OLD_KITS: { canvas: string; page: string; frames: { name: string; html: string }[] }[] = [
  {
    canvas: 'Old marketing kit (2024)',
    page: '01 Blocks · A–L',
    frames: [
      { name: 'Hero with app screenshot', html: block('Every interview, searchable', '<a class="btn">Start free</a>') },
      {
        name: 'Hero centered headline',
        html: block('Research your team can read', '<a class="btn ghost">See how</a>'),
      },
      {
        name: 'Pricing 3 tiers',
        html: block('Pricing', tier('Team', '$24', 'Weekly research.', ['Unlimited interviews'], true)),
      },
      { name: 'Pricing toggle monthly yearly', html: block('Pricing plans', '<p>Monthly · Yearly (save 20%)</p>') },
      {
        name: 'Testimonial quote large',
        html: block('What teams say', '<blockquote>“The whole team reads the board on Monday.”</blockquote>'),
      },
      { name: 'FAQ accordion', html: block('Frequently asked questions', '<p>Can I import recordings from Zoom?</p>') },
      { name: 'Footer 3 columns', html: block('Footer', '<p>Product · Company · Legal</p>') },
      {
        name: 'Primary button set',
        html: block('Buttons', '<a class="btn">Start free</a> <a class="btn ghost">Tour</a>'),
      },
    ],
  },
  {
    canvas: 'App kit v2',
    page: '02 App · L–Z',
    frames: [
      {
        name: 'Primary button set',
        html: block('Buttons', '<a class="btn">Start free</a> <a class="btn ghost">Tour</a>'),
      },
      { name: 'Search field with shortcut', html: block('Search', '<input placeholder="Search interviews  ⌘K">') },
      { name: 'Text field states', html: block('Input', '<input value="Northwind research">') },
      {
        name: 'Interview card',
        html: block('Card', noteCard('Discovery — Lena', 'Fri', ['Mobile'], 'It has to work one-handed.')),
      },
      { name: 'Stat tile row', html: block('Stats', stat('Interviews', '38', '+12')) },
      { name: 'Sidebar navigation', html: block('Sidebar nav', '<p>Interviews · Insights · Tags</p>') },
      { name: 'Tabs underline', html: block('Tabs', '<p>Transcript · Highlights</p>') },
      { name: 'Tag chips', html: block('Tags', '<span>Pricing</span> <span>Churn</span>') },
      { name: 'Avatar stack badge', html: block('Avatars', '<span>PR</span><span>MB</span>') },
      { name: 'Dashboard overview', html: block('Interviews dashboard', '<p>38 interviews · 126 insights</p>') },
      { name: 'Welcome onboarding step', html: block('Welcome to Fieldnote', '<p>Name your workspace</p>') },
      { name: 'Sign in screen', html: block('Sign in', '<input placeholder="Email">') },
      { name: 'Settings profile', html: block('Profile settings', '<p>Name · Email · Role</p>') },
      { name: 'Billing settings', html: block('Billing', '<p>Team plan · 8 seats</p>') },
    ],
  },
]

/* -------------------------------------------------------------------- */
/* the canvas skill and the demo repo the fake desktop device serves      */
/* -------------------------------------------------------------------- */

export const SKILL = {
  name: 'pricing-page',
  description: 'Use when designing or changing a Fieldnote pricing page or plan table.',
  markdown: `# How we do a pricing page at Fieldnote

- Three tiers: Starter (free), Team (featured, dark card), Enterprise (Custom).
- Price per seat per month, never per year. Yearly savings go in a toggle above the cards.
- The featured card uses \`--fn-ink\` as its fill and the amber "Most teams" badge.
- Every tier has one primary action, 44px high, from the Button component.
- Under the cards: a four-question FAQ (bk.faq) and the logo row.
- No "Contact sales" on Starter or Team.`,
}

/** The demo repo: tokens drift from the canvas on purpose (green, amber, radius, one new colour). */
export const REPO_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fieldnote-web', private: true, dependencies: { react: '^19.0.0' } }, null, 2),
  'src/styles/tokens.css': `:root {
  --fn-green: #2a6248;
  --fn-green-soft: #e3efe8;
  --fn-ink: #1c211f;
  --fn-ink-soft: #5b635f;
  --fn-paper: #faf8f3;
  --fn-line: #e6e2d8;
  --fn-amber: #f0a531;
  --fn-coral: #e46f5c;
  --fn-radius: 12px;
  --fn-space: 16px;
}
`,
  'src/components/Button.tsx': `export function Button(props: { children: React.ReactNode; variant?: 'primary' | 'ghost' }) {
  return <button className={\`btn \${props.variant ?? 'primary'}\`}>{props.children}</button>
}
`,
  'src/pages/Pricing.tsx': `import { Button } from '../components/Button'

export default function Pricing() {
  return <main>{/* TODO: pricing tiers */}<Button>Start free</Button></main>
}
`,
  'README.md': '# fieldnote-web\n\nThe Fieldnote marketing site and app shell.\n',
}

/* -------------------------------------------------------------------- */
/* what the demo model writes: a pricing rework and two duel entries      */
/* -------------------------------------------------------------------- */

export const PRICING_V2 = doc(
  `${NAV}<section style="padding:48px 72px;text-align:center"><h1 style="font-size:52px;letter-spacing:-.03em;font-weight:700">Pricing that grows with your research</h1>
<p style="font-size:18px;color:var(--fn-ink-soft);margin-top:14px">Free for your first 10 interviews. No credit card.</p>
<div style="display:inline-flex;gap:4px;padding:4px;background:#f2efe7;border-radius:12px;font-size:14px;margin-top:26px"><span style="padding:8px 16px;border-radius:9px;background:#fff;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)">Monthly</span><span style="padding:8px 16px;color:var(--fn-ink-soft)">Yearly · save 20%</span></div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:36px;text-align:left">
${tier('Starter', '$0', 'For a researcher trying Fieldnote on a real project.', ['10 interviews a month', 'Transcripts in 30 languages', 'One shared board'])}
${tier('Team', '$24', 'For product teams that interview every week.', ['Unlimited interviews', 'AI tags and highlight reels', 'Slack and Linear sync', 'Roles and guest access'], true)}
${tier('Enterprise', 'Custom', 'For research ops across several teams.', ['SSO and SCIM', 'Data residency in the EU', 'Audit log', 'A named research partner'])}
</div></section>`,
  BTN,
)

function onboarding(variant: 'split' | 'centered'): string {
  const sizes = ['Just me', '2–10', '11–50', '50+']
    .map(
      (s, i) =>
        `<span style="padding:10px 14px;border-radius:10px;font-weight:500;${i === 1 ? 'background:var(--fn-green-soft);color:var(--fn-green);box-shadow:inset 0 0 0 1px var(--fn-green)' : 'box-shadow:inset 0 0 0 1px var(--fn-line)'}">${s}</span>`,
    )
    .join('')
  const form = `<div style="display:grid;gap:18px;width:420px"><span style="font-size:13px;font-weight:600;color:var(--fn-green)">Step 1 of 3</span><h1 style="font-size:38px;line-height:1.1;letter-spacing:-.03em">Name your research workspace</h1><p style="color:var(--fn-ink-soft);font-size:16px;line-height:1.5">Your team will find every interview here.</p>${input('default', 'var(--fn-line)')}<label style="display:grid;gap:6px;font-size:13px;font-weight:500">Team size<span style="display:flex;gap:8px">${sizes}</span></label><a class="btn" style="justify-content:center;margin-top:8px">Continue</a></div>`
  if (variant === 'split') {
    return doc(
      `<div style="display:grid;grid-template-columns:1fr 1fr;height:100vh"><div style="padding:48px 80px;display:flex;flex-direction:column;justify-content:space-between">${LOGO}${form}<span style="font-size:13px;color:var(--fn-ink-soft)">You can change this later in Settings.</span></div><div style="background:linear-gradient(160deg,#e3efe8,#f4ead7);padding:80px 64px;display:grid;gap:14px;align-content:center">${noteCard('Onboarding call — Priya', 'Tue 14:00', ['Pricing', 'Setup'], 'We almost gave up during setup.')}${noteCard('Churn interview — Marco', 'Mon 10:30', ['Churn'], 'Without a CSV export it never stuck.')}</div></div>`,
      BTN,
    )
  }
  return doc(
    `<div style="height:100vh;display:grid;place-items:center;background:radial-gradient(80% 60% at 50% 0%,#e3efe8,var(--fn-paper))"><div style="display:grid;gap:34px;justify-items:center">${LOGO}${form}</div></div>`,
    BTN,
  )
}

export const ONBOARDING_SPLIT = onboarding('split')
export const ONBOARDING_CENTERED = onboarding('centered')
