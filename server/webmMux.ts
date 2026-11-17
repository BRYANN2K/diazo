/** server/webmMux.ts — packs encoded video chunks into a WebM file.
 *  The server render harness encodes each seeked frame through WebCodecs
 *  at an explicit timestamp; this writes the EBML container around the
 *  chunks it returns: one video track, no audio, a new cluster every
 *  ~30 s so SimpleBlock timestamps stay inside their int16 range. The
 *  segment size is written as unknown, which players accept for a file
 *  whose length was not known when the header went out. */

export interface WebmChunk {
  /** 'key' starts a decodable run; 'delta' depends on earlier frames */
  type: 'key' | 'delta'
  /** microseconds since stream start */
  timestampUs: number
  data: Buffer
}

/* ---- EBML primitives ---- */

/** EBML variable-size integer: a size field, not an element id. */
function vint(size: number): Buffer {
  /* len bytes hold 7*len value bits — a 1-byte vint tops at 126, the
   * all-ones value being the reserved 'unknown size' marker. Bytes are
   * assembled by hand: JS bitwise ops are 32-bit, so `1 << (7*len)`
   * wraps for len >= 5 and `|` cannot set the marker at 35+ bits. */
  for (let len = 1; len <= 8; len++) {
    if (size < 2 ** (7 * len) - 1) {
      const buf = Buffer.alloc(len)
      let v = size
      for (let i = len - 1; i >= 1; i--) {
        buf[i] = v % 256
        v = Math.floor(v / 256)
      }
      buf[0] = v | (1 << (8 - len))
      return buf
    }
  }
  throw new Error('element too large to size')
}

function elem(id: number, payload: Buffer): Buffer {
  /* ids are written big-endian in their natural width (1-4 bytes) */
  const width = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1
  const head = Buffer.alloc(width)
  head.writeUIntBE(id, 0, width)
  return Buffer.concat([head, vint(payload.length), payload])
}

function uintElem(id: number, value: number): Buffer {
  const bytes: number[] = []
  let v = value
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (v > 0)
  return elem(id, Buffer.from(bytes))
}

const strElem = (id: number, value: string) => elem(id, Buffer.from(value, 'ascii'))

function floatElem(id: number, value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeDoubleBE(value)
  return elem(id, buf)
}

/* ---- element ids ---- */
const EBML = 0x1a45dfa3
/* Segment id 0x18538067 — written literally below with its unknown-size vint */
const INFO = 0x1549a966
const TIMESTAMP_SCALE = 0x2ad7b1
const DURATION = 0x4489
const MUXING_APP = 0x4d80
const WRITING_APP = 0x5741
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_NUMBER = 0xd7
const TRACK_UID = 0x73c5
const TRACK_TYPE = 0x83
const FLAG_LACING = 0x9c
const CODEC_ID = 0x86
const VIDEO = 0xe0
const PIXEL_WIDTH = 0xb0
const PIXEL_HEIGHT = 0xba
const CLUSTER = 0x1f43b675
const TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3

const EBML_HEADER = elem(
  EBML,
  Buffer.concat([
    uintElem(0x4286, 1), // EBMLVersion
    uintElem(0x42f7, 1), // EBMLReadVersion
    uintElem(0x42f2, 4), // EBMLMaxIDLength
    uintElem(0x42f3, 8), // EBMLMaxSizeLength
    strElem(0x4282, 'webm'), // DocType
    uintElem(0x4287, 4), // DocTypeVersion
    uintElem(0x4285, 2), // DocTypeReadVersion
  ]),
)

/** SimpleBlock: track 1, int16 timestamp relative to its cluster, flags. */
function simpleBlock(chunk: WebmChunk, clusterTimecodeMs: number): Buffer {
  const rel = Math.round(chunk.timestampUs / 1000) - clusterTimecodeMs
  const head = Buffer.alloc(4)
  head[0] = 0x81 // track 1 as a 1-byte vint
  head.writeInt16BE(rel, 1)
  head[3] = chunk.type === 'key' ? 0x80 : 0x00
  return elem(SIMPLE_BLOCK, Buffer.concat([head, chunk.data]))
}

/** Mux encoded VP8/VP9 chunks into a WebM file. Chunks must be in
 *  decode order — the order the encoder emitted them. `codec` is the
 *  WebCodecs codec string. */
export function muxWebm(
  chunks: WebmChunk[],
  options: { codec: string; width: number; height: number; durationMs: number },
): Buffer {
  if (!chunks.length) throw new Error('no encoded chunks')
  const codecId = options.codec.startsWith('vp09') || options.codec === 'vp9' ? 'V_VP9' : 'V_VP8'

  const info = elem(
    INFO,
    Buffer.concat([
      uintElem(TIMESTAMP_SCALE, 1_000_000), // timestamp unit = 1 ms
      floatElem(DURATION, options.durationMs),
      strElem(MUXING_APP, 'diazo'),
      strElem(WRITING_APP, 'diazo'),
    ]),
  )
  const tracks = elem(
    TRACKS,
    elem(
      TRACK_ENTRY,
      Buffer.concat([
        uintElem(TRACK_NUMBER, 1),
        uintElem(TRACK_UID, 1),
        uintElem(TRACK_TYPE, 1), // video
        uintElem(FLAG_LACING, 0),
        strElem(CODEC_ID, codecId),
        elem(VIDEO, Buffer.concat([uintElem(PIXEL_WIDTH, options.width), uintElem(PIXEL_HEIGHT, options.height)])),
      ]),
    ),
  )

  const clusters: Buffer[] = []
  let clusterStartMs: number | null = null
  let blocks: Buffer[] = []
  const closeCluster = () => {
    if (clusterStartMs === null) return
    clusters.push(elem(CLUSTER, Buffer.concat([uintElem(TIMECODE, clusterStartMs), ...blocks])))
    blocks = []
    clusterStartMs = null
  }
  for (const chunk of chunks) {
    const tsMs = Math.round(chunk.timestampUs / 1000)
    if (clusterStartMs === null || tsMs - clusterStartMs > 30_000) {
      closeCluster()
      clusterStartMs = tsMs
    }
    blocks.push(simpleBlock(chunk, clusterStartMs))
  }
  closeCluster()

  /* segment size unknown (all-ones vint): legal for streamed segments */
  const segmentHead = Buffer.from([0x18, 0x53, 0x80, 0x67, 0xff])
  return Buffer.concat([EBML_HEADER, segmentHead, info, tracks, ...clusters])
}
