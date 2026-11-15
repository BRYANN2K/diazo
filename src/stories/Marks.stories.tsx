import type { Meta, StoryObj } from '@storybook/react-vite'
import { AgentIcon } from '@/components/AgentIcon'
import { DiazoAgentMark, DiazoMark, DiazoWordmark, Logo } from '@/components/Logo'
import { RoleMark } from '@/components/RoleMark'
import { Avatar } from '@/components/ui/avatar'
import { Wordmark } from '@/components/ui/wordmark'
import { RadioTowerIcon, WebIcon } from '@/components/ui/icons'
import { APP_ICON_BRANDS, AppIcon, BRANDS, BrandMark } from '@/components/ui/brand-mark'
import { MetaTile } from '@/components/AutomateShell'
import { ClockTile } from '@/components/AutomateShell'
import { AGENT_ROLES } from '../../shared/agents'
import { colorFor } from '../../shared/types'

/**
 * Every mark the product wears: its own, the agents', the people's and the
 * brands it connects to. These are the only places a logo should come from.
 */
const meta = { title: 'Marks' } satisfies Meta
export default meta

type Story = StoryObj<typeof meta>

export const Diazo: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <Logo />
        <Logo className="size-[24px]" />
        <DiazoMark size={24} />
        <DiazoMark size={13} />
        <DiazoMark size={24} tone="color" />
      </div>
      <div className="flex items-center gap-6 text-ink">
        <Wordmark />
        <Wordmark size="sm" />
        <DiazoWordmark height={28} />
        <DiazoWordmark height={28} tone="mono" />
      </div>
    </div>
  ),
}

/** The reveal, played once on the home greeting: the original D draws, the
 *  blue print lands on it. Remount the story to replay it. */
export const DiazoReveal: Story = {
  render: () => (
    <div className="flex items-end gap-6 text-ink">
      <DiazoMark animated size={62} className="block" />
      <DiazoMark animated size={24} className="block" />
    </div>
  ),
}

/** The Diazo Agent: at rest, at work (the presence pill's glaze state), solid
 *  (a role's badge, in its crew colour) and as a presence face. */
export const DiazoAgent: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <DiazoAgentMark size={48} />
        <DiazoAgentMark size={48} working />
        <DiazoAgentMark size={48} solid />
        <DiazoAgentMark size={24} />
        <DiazoAgentMark size={24} working />
      </div>
      <div className="flex items-center gap-4">
        <Avatar name="Diazo" kind="agent" size={24} />
        <Avatar name="Diazo" kind="agent" size={24} glaze />
        <Avatar name="Claude Code" kind="agent" size={24} glaze />
        {AGENT_ROLES.slice(0, 4).map((role) => (
          <RoleMark key={role.id} role={role} size={22} />
        ))}
      </div>
    </div>
  ),
}

export const Agents: Story = {
  render: () => (
    <div className="flex items-center gap-5 text-body">
      {['Claude Code', 'Codex', 'Cursor', 'Diazo', 'Some MCP client'].map((name) => (
        <span key={name} className="flex items-center gap-2" style={{ color: colorFor(name) }}>
          <AgentIcon name={name} size={14} />
          <span className="text-ink-soft">{name}</span>
        </span>
      ))}
    </div>
  ),
}

/** Every third-party mark, from the one registry (`<BrandMark brand size />`). */
export const Brands: Story = {
  render: () => (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4">
        {BRANDS.map((brand) => (
          <span key={brand} className="flex flex-col items-center gap-1.5">
            <BrandMark brand={brand} size={24} />
            <span className="font-mono text-micro text-ink-faint">{brand}</span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4">
        {BRANDS.map((brand) => (
          <BrandMark key={brand} brand={brand} size={16} />
        ))}
        <span className="ml-2 text-caption text-ink-faint">16px in logo rows, 24px on picker tiles</span>
      </div>
    </div>
  ),
}

/** Providers, import sources and export formats as app icons
 *  (`<AppIcon brand size />`): 32px in a list row, 40px beside a modal title. */
export const AppIcons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      {APP_ICON_BRANDS.map((brand) => (
        <span key={brand} className="flex flex-col items-center gap-1.5">
          <AppIcon brand={brand} />
          <span className="font-mono text-micro text-ink-faint">{brand}</span>
        </span>
      ))}
    </div>
  ),
}

/** The feature tiles that compose a mark: a brand on a paper tile, the automation chain's clock. */
export const Tiles: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <span className="grid size-4 place-items-center rounded-[4px] bg-surface shadow-ring">
        <BrandMark brand="figma" size={12} />
      </span>
      <MetaTile size={24} />
      <ClockTile size={24} />
      <WebIcon className="size-5 text-ink" />
      <RadioTowerIcon className="size-5 text-ink" />
    </div>
  ),
}
