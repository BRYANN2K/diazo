import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { NumberRoll } from '@/components/ui/number-roll'
import { ThinkingStatus } from '@/components/ui/thinking-status'

/**
 * Agent orange is for anything an agent does: the status line, the beam round
 * a frame being written, agent badges and chips. Signal blue stays with people
 * and selection. Every AI state has a reduced-motion fallback.
 */
const meta = { title: 'Primitives/AI states' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

export const Thinking: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ThinkingStatus steps={['Reading the Pricing frame…', 'Checking the type tokens…', 'Writing the Team card…']} />
      <ThinkingStatus steps={[]} done="Thought for 12s · 3 frames changed" />
    </div>
  ),
}

function RollDemo() {
  const [cents, setCents] = useState(48)
  return (
    <div className="flex items-center gap-4">
      <NumberRoll value={`$0.${String(cents).padStart(2, '0')}7`} />
      <NumberRoll size="lg" value={`${(12480 + cents * 31).toLocaleString('en-US')}`} />
      <Button size="sm" onClick={() => setCents((n) => (n + 1) % 100)}>
        Spend
      </Button>
    </div>
  )
}

export const Numbers: Story = { name: 'Number roll', render: () => <RollDemo /> }

export const Tags: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Default</Badge>
      <Badge tone="signal">You</Badge>
      <Badge tone="agent">Writing</Badge>
      <Badge tone="ok">Connected</Badge>
      <Badge tone="caution">A11y 4 · 375</Badge>
      <Badge tone="danger">Run failed</Badge>
      <Chip>Pricing page</Chip>
      <Chip tone="agent">Latest Opus · high</Chip>
      <Chip on>Heroes</Chip>
    </div>
  ),
}

export const Beam: Story = {
  name: 'Agent writing beam',
  render: () => (
    <div className="agent-beam relative grid h-[180px] w-[280px] place-items-center rounded-row bg-surface shadow-ring">
      <span className="text-caption text-ink-3">Diazo is writing this frame</span>
    </div>
  ),
}
