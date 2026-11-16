import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { TILE_ASPECTS, type TileAspect } from './tile'

/* The shapes a screen waits on (01 Foundations · Skeleton). `tile` is a
   Tile's footprint (the cover at its aspect over a one-line body), `row` a
   56px list row, `card` a 150px settings or integration card. With no shape
   the caller sizes it. A band of light crosses the well every 1.6s; under
   reduced motion it holds a still tint. Spinners belong inside buttons only. */
const skeletonVariants = cva(
  'animate-shimmer bg-[linear-gradient(90deg,var(--well)_25%,color-mix(in_srgb,var(--well)_40%,var(--surface))_50%,var(--well)_75%)] bg-size-[200%_100%]',
  {
    variants: {
      shape: {
        none: 'rounded-[6px]',
        tile: 'flex flex-col rounded-card',
        row: 'h-14 rounded-row',
        card: 'min-h-[150px] rounded-card',
      },
    },
    defaultVariants: { shape: 'none' },
  },
)

type SkeletonProps = React.ComponentProps<'div'> &
  VariantProps<typeof skeletonVariants> & {
    /** staggers a grid of them so the wait reads as one wave, not a flash */
    index?: number
    /** `tile` only: the cover aspect of the Tile it stands in for */
    aspect?: TileAspect
  }

/** Loading placeholder — the pulse every empty tile and row shares. */
function Skeleton({ className, shape, index = 0, aspect = '5/3', style, children, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonVariants({ shape, className }))}
      style={{ animationDelay: `${Math.min(index, 7) * 0.03}s`, ...style }}
      {...props}
    >
      {shape === 'tile' ? (
        <>
          <div aria-hidden className={TILE_ASPECTS[aspect]} />
          <div aria-hidden className="h-[60px]" />
        </>
      ) : (
        children
      )}
    </div>
  )
}

export { Skeleton, skeletonVariants }
