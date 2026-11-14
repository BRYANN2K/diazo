import { useEffect, useState } from 'react'
import type {
  CurationCategoryView,
  CurationEdit,
  CurationJobView,
  CurationPlanView,
  CurationSample,
} from '../../../shared/libraryCuration'
import { priceRun } from '../../../shared/modelPrices'
import { ApiError, api } from '../../lib/api'
import { navigate } from '../../lib/navigate'
import { useT } from '../../lib/i18n'
import { cn } from '@/lib/utils'
import { FramePreview } from '../FramePreview'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Callout } from '../ui/callout'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from '../ui/modal'
import { Pressable } from '../ui/pressable'
import { Progress } from '../ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

const WORKING = new Set(['gathering', 'proposing', 'classifying', 'applying'])
const POLL_MS = 1500
/** Items per filing call on the server (BATCH), for the estimate. */
const PER_CALL = 60

function errorOf(error: unknown): string {
  if (error instanceof ApiError && typeof error.body.error === 'string') return error.body.error
  return error instanceof Error ? error.message : String(error)
}

/**
 * "Organise with AI": pick several canvases, let a model propose one
 * category tree and file every item, review and edit it, then create the
 * library (a new canvas; the picked ones are never changed). A run in
 * progress or waiting for review is picked up again when the modal opens.
 */
export function CurateLibraryModal({
  initialSources = [],
  onClose,
}: {
  initialSources?: string[]
  onClose: () => void
}) {
  const t = useT()
  const [job, setJob] = useState<CurationJobView | null>(null)
  const [looked, setLooked] = useState(false)
  /* opened on a canvas: only a run still working takes over the picker */
  const preselected = initialSources.length > 0

  useEffect(() => {
    let stale = false
    api
      .listCurations()
      .then((r) => {
        if (stale) return
        const open = r.curations.find((c) => c.status !== 'cancelled' && c.status !== 'applied')
        if (open && !preselected) setJob(open)
        else if (open && WORKING.has(open.status)) setJob(open)
        setLooked(true)
      })
      .catch(() => {
        if (!stale) setLooked(true)
      })
    return () => {
      stale = true
    }
  }, [preselected])

  const jobId = job?.id
  const polling = !!job && WORKING.has(job.status)
  useEffect(() => {
    if (!jobId || !polling) return
    const timer = setInterval(() => {
      api
        .curation(jobId)
        .then(setJob)
        .catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [jobId, polling])

  return (
    <Modal size="xl" onClose={onClose}>
      <ModalTitle>{t('library.curateTitle')}</ModalTitle>
      {!looked ? (
        <ModalLede>{t('library.previewing')}</ModalLede>
      ) : !job || job.status === 'cancelled' ? (
        <SourcesStep initial={initialSources} onStarted={setJob} onClose={onClose} />
      ) : job.status === 'ready' ? (
        <ReviewStep job={job} onApplying={setJob} onClose={onClose} />
      ) : job.status === 'applied' ? (
        <AppliedStep job={job} onClose={onClose} />
      ) : (
        <ProgressStep job={job} onJob={setJob} onClose={onClose} />
      )}
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

function SourcesStep({
  initial,
  onStarted,
  onClose,
}: {
  initial: string[]
  onStarted: (job: CurationJobView) => void
  onClose: () => void
}) {
  const t = useT()
  const [sources, setSources] = useState<{ id: string; name: string; frames: number; library: boolean }[] | null>(null)
  const [max, setMax] = useState(8)
  const [picked, setPicked] = useState<string[]>(initial)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    api
      .curationSources()
      .then((r) => {
        if (stale) return
        setSources(r.sources)
        setMax(r.max)
      })
      .catch(() => {
        if (!stale) setSources([])
      })
    return () => {
      stale = true
    }
  }, [])

  const frames = (sources ?? []).filter((s) => picked.includes(s.id)).reduce((n, s) => n + s.frames, 0)
  const toggle = (id: string, on: boolean) =>
    setPicked((current) => (on ? [...current.filter((p) => p !== id), id] : current.filter((p) => p !== id)))

  async function start() {
    setBusy(true)
    setError(null)
    try {
      onStarted(await api.startCuration(picked, name.trim() || undefined))
    } catch (e) {
      setError(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ModalLede>{t('library.curateLede')}</ModalLede>
      <div className="mt-4 flex flex-col gap-1.5">
        <span className="text-label font-medium text-ink">{t('library.curateSources')}</span>
        <p className="text-caption text-ink-faint">{t('library.curateSourcesHint')}</p>
        {sources === null ? (
          <p className="text-copy text-ink-soft">{t('library.previewing')}</p>
        ) : sources.length === 0 ? (
          <p className="text-copy text-ink-soft">{t('library.curateNoSources')}</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto" data-testid="curate-sources">
            {sources.map((s) => {
              const on = picked.includes(s.id)
              return (
                <li key={s.id}>
                  <label className="relative flex cursor-pointer items-center gap-2.5 rounded-row px-2 py-1.5 hover:bg-paper-deep">
                    <Checkbox
                      checked={on}
                      disabled={!on && picked.length >= max}
                      onChange={(e) => toggle(s.id, e.target.checked)}
                      aria-label={s.name}
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-ink">{s.name}</span>
                    {s.library && <Badge tone="outline">{t('library.curateIsLibrary')}</Badge>}
                    {on && <Badge>{picked.indexOf(s.id) + 1}</Badge>}
                    <span className="text-caption text-ink-faint">
                      {t('library.curateFrames', { count: s.frames })}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-label font-medium text-ink">{t('library.curateName')}</span>
          <Input
            variant="well"
            value={name}
            placeholder={sources?.find((s) => s.id === picked[0])?.name ?? ''}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {frames > 0 && (
          <p className="text-caption text-ink-faint">
            {t('library.curateEstimate', { calls: Math.ceil(frames / PER_CALL) + 1, frames })}
          </p>
        )}
        {error && <Callout tone="error">{t('library.curateStartFailed', { error })}</Callout>}
      </div>
      <ModalActions>
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.cancel')}</Button>
        <Button variant="primary" disabled={!picked.length || busy} onClick={() => void start()}>
          {busy ? t('library.curateStarting') : t('library.curateStart')}
        </Button>
      </ModalActions>
    </>
  )
}

/* ---------------------------------------------------------------- */

function CostLine({ job }: { job: CurationJobView }) {
  const t = useT()
  const cost = priceRun(job.usage).costUsd
  return (
    <p className="text-caption text-ink-faint">
      {t('library.curateCalls', { count: job.calls })}
      {cost !== undefined ? ` · ${t('library.curateCost', { cost: cost.toFixed(2) })}` : ''}
      {job.model ? ` · ${job.model}` : ''}
    </p>
  )
}

function ProgressStep({
  job,
  onJob,
  onClose,
}: {
  job: CurationJobView
  onJob: (job: CurationJobView) => void
  onClose: () => void
}) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const act = (run: () => Promise<CurationJobView>) => {
    setError(null)
    run()
      .then(onJob)
      .catch((e: unknown) => setError(errorOf(e)))
  }
  const phase =
    job.status === 'gathering' ||
    job.status === 'proposing' ||
    job.status === 'classifying' ||
    job.status === 'applying'
      ? job.status
      : null
  return (
    <>
      {phase ? (
        <div className="mt-4 flex flex-col gap-2" aria-live="polite" data-testid="curate-progress">
          <span className="text-label font-medium text-ink">
            {phase === 'applying'
              ? t('library.curateApplying', { done: job.progress.done, total: job.progress.total })
              : t(`library.curatePhase_${phase}`)}
          </span>
          <Progress value={job.progress.done} max={Math.max(1, job.progress.total)} />
          {phase !== 'applying' && job.progress.total > 0 && (
            <p className="text-caption text-ink-faint">
              {t('library.curateProgress', { done: job.progress.done, total: job.progress.total })}
            </p>
          )}
          <CostLine job={job} />
        </div>
      ) : (
        <Callout tone="error" className="mt-4">
          {t('library.curateFailed', { error: job.error ?? '' })}
        </Callout>
      )}
      {error && (
        <Callout tone="error" className="mt-2">
          {error}
        </Callout>
      )}
      <ModalActions>
        {job.status === 'failed' && (
          <Button onClick={() => act(() => api.cancelCuration(job.id))}>{t('library.curateNew')}</Button>
        )}
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.curateClose')}</Button>
        {job.status === 'failed' ? (
          <Button variant="primary" onClick={() => act(() => api.retryCuration(job.id))}>
            {t('library.curateRetry')}
          </Button>
        ) : phase !== 'applying' ? (
          <Button onClick={() => act(() => api.cancelCuration(job.id))}>{t('library.curateCancel')}</Button>
        ) : null}
      </ModalActions>
    </>
  )
}

/* ---------------------------------------------------------------- */

function flatten(tree: CurationCategoryView[], depth = 0): { node: CurationCategoryView; depth: number }[] {
  return tree.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)])
}

function SampleGrid({
  samples,
  categories,
  current,
  onMove,
}: {
  samples: CurationSample[]
  categories: { node: CurationCategoryView; depth: number }[]
  current: string | null
  onMove: (key: string, to: string | null) => void
}) {
  const t = useT()
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3" data-testid="curate-items">
      {samples.map((s) => (
        <li key={s.key} className="flex min-w-0 flex-col gap-1">
          <div className="aspect-[4/3] overflow-hidden rounded-row bg-paper-deep shadow-ring">
            <FramePreview frameId={s.frames[0]?.frameId} empty={null} />
          </div>
          <span className="truncate text-caption text-ink" title={s.label}>
            {s.label}
          </span>
          <Select value={current ?? 'none'} onValueChange={(to) => onMove(s.key, to === 'none' ? null : to)}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('library.curateMoveTo')}>
              <SelectValue placeholder={t('library.curateMoveTo')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('library.curateUnclassify')}</SelectItem>
              {categories.map(({ node, depth }) => (
                <SelectItem key={node.id} value={node.id}>
                  {`${'  '.repeat(depth)}${node.path}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </li>
      ))}
    </ul>
  )
}

function ReviewStep({
  job,
  onApplying,
  onClose,
}: {
  job: CurationJobView
  onApplying: (job: CurationJobView) => void
  onClose: () => void
}) {
  const t = useT()
  const [plan, setPlan] = useState<CurationPlanView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [items, setItems] = useState<{ category: string; list: CurationSample[]; cursor?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keepUnsorted, setKeepUnsorted] = useState(true)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    let stale = false
    api
      .curationPlan(job.id)
      .then((p) => {
        if (stale) return
        setPlan(p)
        setSelected((current) => current ?? p.tree[0]?.id ?? null)
      })
      .catch((e: unknown) => {
        if (!stale) setError(errorOf(e))
      })
    return () => {
      stale = true
    }
  }, [job.id])

  const shown = selected ?? 'none'
  const planKey = plan ? JSON.stringify(plan.totals) + JSON.stringify(plan.tree.map((n) => [n.id, n.count])) : ''
  useEffect(() => {
    if (!planKey) return
    let stale = false
    api
      .curationItems(job.id, shown)
      .then((r) => {
        if (!stale) setItems({ category: shown, list: r.items, ...(r.cursor ? { cursor: r.cursor } : {}) })
      })
      .catch(() => {
        if (!stale) setItems({ category: shown, list: [] })
      })
    return () => {
      stale = true
    }
  }, [job.id, shown, planKey])

  async function edit(edits: CurationEdit[]) {
    setError(null)
    try {
      setPlan(await api.editCuration(job.id, edits))
    } catch (e) {
      setError(t('library.curateEditFailed', { error: errorOf(e) }))
    }
  }

  async function more() {
    if (!items?.cursor) return
    const r = await api.curationItems(job.id, items.category, items.cursor)
    setItems({ category: items.category, list: [...items.list, ...r.items], ...(r.cursor ? { cursor: r.cursor } : {}) })
  }

  async function create() {
    setBusy(true)
    setError(null)
    try {
      onApplying(await api.applyCuration(job.id, keepUnsorted))
    } catch (e) {
      setError(errorOf(e))
      setBusy(false)
    }
  }

  if (!plan) {
    return error ? <Callout tone="error">{error}</Callout> : <ModalLede>{t('library.previewing')}</ModalLede>
  }
  const categories = flatten(plan.tree)
  const node = categories.find((c) => c.node.id === selected)?.node ?? null

  return (
    <>
      <ModalLede>{t('library.curateReviewTitle')}</ModalLede>
      <p className="mt-1 text-caption text-ink-faint" data-testid="curate-totals">
        {t('library.curateTotals', plan.totals)}
      </p>
      <CostLine job={job} />
      {plan.fallback && (
        <Callout className="mt-2" tone="neutral">
          {t('library.curateFallback')}
        </Callout>
      )}
      <Tabs defaultValue="tree" className="mt-3">
        <TabsList>
          <TabsTrigger value="tree" onClick={() => setSelected(categories[0]?.node.id ?? null)}>
            {t('library.curateTabTree')}
          </TabsTrigger>
          <TabsTrigger value="unclassified" onClick={() => setSelected(null)}>
            {t('library.curateTabUnclassified', { count: plan.totals.unclassified })}
          </TabsTrigger>
          <TabsTrigger value="duplicates">
            {t('library.curateTabDuplicates', { count: plan.totals.duplicates + plan.totals.existing })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tree" className="mt-2">
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <div className="flex flex-col gap-1">
              <ul className="flex max-h-96 flex-col overflow-y-auto" data-testid="curate-tree">
                {categories.map(({ node: c, depth }) => (
                  <li key={c.id}>
                    <Pressable
                      onClick={() => setSelected(c.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-row px-2 py-1 text-body text-ink hover:bg-paper-deep',
                        selected === c.id && 'bg-paper-deep',
                      )}
                      style={{ paddingLeft: 8 + depth * 14 }}
                    >
                      <span className={cn('min-w-0 flex-1 truncate', depth === 0 && 'font-medium')}>{c.name}</span>
                      <span className="text-caption text-ink-faint">{c.count}</span>
                    </Pressable>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-1.5">
                <Input
                  inputSize="sm"
                  variant="well"
                  className="min-w-0 flex-1"
                  value={newName}
                  placeholder={t('library.curateAddPlaceholder')}
                  aria-label={t('library.curateAddPlaceholder')}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={!newName.trim()}
                  onClick={() => {
                    void edit([{ op: 'add', parentId: node?.id ?? null, name: newName }])
                    setNewName('')
                  }}
                >
                  {node ? t('library.curateAdd') : t('library.curateAddTop')}
                </Button>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {!node ? (
                <p className="text-copy text-ink-soft">{t('library.curatePickCategory')}</p>
              ) : (
                <CategoryEditor
                  key={node.id + node.name}
                  node={node}
                  categories={categories}
                  onEdit={(edits) => void edit(edits)}
                  onDeleted={() => setSelected(null)}
                />
              )}
              {node && items?.category === node.id && (
                <>
                  <span className="text-label font-medium text-ink">
                    {t('library.curateItems')} · {t('library.curateCount', { count: node.own })}
                  </span>
                  <SampleGrid
                    samples={items.list}
                    categories={categories}
                    current={node.id}
                    onMove={(key, to) => void edit([{ op: 'assign', keys: [key], to }])}
                  />
                  {items.cursor && (
                    <Button size="sm" onClick={() => void more()}>
                      {t('library.curateMore')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="unclassified" className="mt-2 flex flex-col gap-2">
          {plan.totals.unclassified === 0 ? (
            <p className="text-copy text-ink-soft">{t('library.curateNothingUnclassified')}</p>
          ) : items?.category === 'none' ? (
            <>
              <SampleGrid
                samples={items.list}
                categories={categories}
                current={null}
                onMove={(key, to) => void edit([{ op: 'assign', keys: [key], to }])}
              />
              {items.cursor && (
                <Button size="sm" onClick={() => void more()}>
                  {t('library.curateMore')}
                </Button>
              )}
            </>
          ) : null}
        </TabsContent>
        <TabsContent value="duplicates" className="mt-2 flex flex-col gap-2">
          {plan.existing.length > 0 && (
            <>
              <span className="text-label font-medium text-ink">
                {t('library.curateExisting', { count: plan.totals.existing })}
              </span>
              <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-caption text-ink-soft">
                {plan.existing.map((e) => (
                  <li key={e.key} className="truncate">
                    {e.label} ·{' '}
                    {t('library.alreadyIn', {
                      library: e.match.libraryName,
                      category: e.match.category,
                      name: e.match.name,
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto text-caption text-ink-faint">
            {plan.duplicates.map((d) => (
              <li key={`${d.dropped.canvasId}:${d.dropped.frameId}`} className="truncate">
                {d.dropped.name} · {t('library.curateDuplicateOf', { name: d.keep })}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
      {error && (
        <Callout tone="error" className="mt-2">
          {error}
        </Callout>
      )}
      <ModalActions>
        <label className="relative flex cursor-pointer items-center gap-2 text-body text-ink-soft">
          <Checkbox checked={keepUnsorted} onChange={(e) => setKeepUnsorted(e.target.checked)} />
          {t('library.curateKeepUnsorted')}
        </label>
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.curateClose')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          {t('library.curateApply')}
        </Button>
      </ModalActions>
    </>
  )
}

function CategoryEditor({
  node,
  categories,
  onEdit,
  onDeleted,
}: {
  node: CurationCategoryView
  categories: { node: CurationCategoryView; depth: number }[]
  onEdit: (edits: CurationEdit[]) => void
  onDeleted: () => void
}) {
  const t = useT()
  const [name, setName] = useState(node.name)
  const others = categories.filter((c) => c.node.id !== node.id && !c.node.path.startsWith(`${node.path}/`))
  return (
    <div className="flex flex-col gap-2 rounded-card p-3 shadow-ring">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-ink-faint">{t('library.curateRename')}</span>
        <Input
          inputSize="sm"
          variant="well"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== node.name && onEdit([{ op: 'rename', id: node.id, name }])}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value="" onValueChange={(into) => onEdit([{ op: 'merge', from: node.id, into }])}>
          <SelectTrigger size="sm" className="w-56" aria-label={t('library.curateMergeInto')}>
            <SelectValue placeholder={t('library.curateMergeInto')} />
          </SelectTrigger>
          <SelectContent>
            {others.map(({ node: c }) => (
              <SelectItem key={c.id} value={c.id}>
                {c.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value=""
          onValueChange={(to) => onEdit([{ op: 'move', id: node.id, parentId: to === 'top' ? null : to }])}
        >
          <SelectTrigger size="sm" className="w-56" aria-label={t('library.curateMoveUnder')}>
            <SelectValue placeholder={t('library.curateMoveUnder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="top">{t('library.curateTopLevel')}</SelectItem>
            {others.map(({ node: c }) => (
              <SelectItem key={c.id} value={c.id}>
                {c.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          title={t('library.curateDeleteHint')}
          onClick={() => {
            onEdit([{ op: 'delete', id: node.id }])
            onDeleted()
          }}
        >
          {t('library.curateDelete')}
        </Button>
        <span className="text-caption text-ink-faint">{t('library.curateCount', { count: node.count })}</span>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- */

function AppliedStep({ job, onClose }: { job: CurationJobView; onClose: () => void }) {
  const t = useT()
  return (
    <>
      <Callout tone="success" className="mt-4">
        {t('library.curateApplied', { name: job.name })}
      </Callout>
      <CostLine job={job} />
      <ModalActions>
        <ModalSpacer />
        <Button onClick={onClose}>{t('library.curateClose')}</Button>
        {job.canvasId && (
          <Button variant="primary" onClick={() => navigate(`/l/${job.canvasId}`)}>
            {t('library.curateOpenLibrary')}
          </Button>
        )}
      </ModalActions>
    </>
  )
}
