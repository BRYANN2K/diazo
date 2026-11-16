/* A frame drawn as an image on the stage (src/lib/frameLod.ts) asks the
   server for a render about as wide as it shows on screen, not the whole
   design at 1x: at 10% zoom a 1280px screen is 128 screen px wide, and a
   full render of it costs a hundred times the pixels it is shown at. The
   widths come in a few fixed steps, so each frame has at most that many
   renders to keep and every viewer asks for the same ones. */

/** The render widths a stage image may ask for, in image px. */
export const FRAME_PREVIEW_WIDTHS = [128, 256, 512, 1024] as const

export type FramePreviewWidth = (typeof FRAME_PREVIEW_WIDTHS)[number]

/** Never render above this density: a small shape at the widest step would
 *  otherwise ask for a bitmap many times its size. */
export const MAX_PREVIEW_SCALE = 2

/** The `?lod=` query as a render width, or null when it is not one of the
 *  steps (the route then refuses it rather than render any size asked). */
export function parsePreviewWidth(value: unknown): FramePreviewWidth | null {
  const n = Number(value)
  return (FRAME_PREVIEW_WIDTHS as readonly number[]).includes(n) ? (n as FramePreviewWidth) : null
}

/** The density a render of a frame `frameWidth` design px wide needs to come
 *  out `width` image px wide. */
export function previewScale(frameWidth: number, width: FramePreviewWidth): number {
  return Math.min(MAX_PREVIEW_SCALE, width / Math.max(1, frameWidth))
}

/** The smallest step at least `screenPx` image px wide (a frame's on-screen
 *  width times the device pixel ratio), the widest step past them all. */
export function previewWidthFor(screenPx: number): FramePreviewWidth {
  for (const width of FRAME_PREVIEW_WIDTHS) if (width >= screenPx) return width
  return FRAME_PREVIEW_WIDTHS[FRAME_PREVIEW_WIDTHS.length - 1]!
}
