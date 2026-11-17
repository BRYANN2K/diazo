import { env } from './env.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Byte storage for uploaded assets. With bucket credentials configured the
 * bytes live in S3-compatible object storage — the env names match what a
 * Railway Bucket injects via variable references (BUCKET, ACCESS_KEY_ID,
 * SECRET_ACCESS_KEY, ENDPOINT, REGION); R2 or S3 work with the same names.
 * Without them (local development) bytes land under ./data/assets, next to
 * PGlite. Either way the assets table is the source of truth for what exists.
 */

const BUCKET = env.BUCKET
const DISK_DIR = path.join(process.cwd(), 'data', 'assets')

export const storageMode: 'bucket' | 'disk' = BUCKET ? 'bucket' : 'disk'

/* keys are `<nanoid>.<ext>`, optionally under the `thumb/` prefix (derived
   frame previews — a folder of their own so they can be purged or lifecycle-
   ruled without touching user uploads), the `bg/` prefix (the curated
   background library, server/backgrounds.ts) or `lt/<canvasId>/` (library
   item thumbnails, server/libraryThumbs.ts). Anything else is a bug, and in
   disk mode the check doubles as the path-traversal guard: known literal
   prefixes, one id segment at most, no dots or slashes in the name. */
function assertKey(key: string) {
  if (!/^(thumb\/|bg\/|lt\/[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key))
    throw new Error(`malformed storage key: ${key}`)
}

let s3: S3Client | undefined
async function client(): Promise<S3Client> {
  if (!s3) {
    /* loaded on demand so dev without a bucket never pays for the SDK */
    const { S3Client } = await import('@aws-sdk/client-s3')
    s3 = new S3Client({
      region: env.REGION,
      endpoint: env.ENDPOINT,
      credentials:
        env.ACCESS_KEY_ID && env.SECRET_ACCESS_KEY
          ? { accessKeyId: env.ACCESS_KEY_ID, secretAccessKey: env.SECRET_ACCESS_KEY }
          : undefined,
    })
  }
  return s3
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mime }))
    return
  }
  await fs.mkdir(path.dirname(path.join(DISK_DIR, key)), { recursive: true })
  await fs.writeFile(path.join(DISK_DIR, key), body)
}

/** The same upload from a file on disk — for payloads built incrementally
 *  (server renders) that should not be read back into memory to be stored. */
export async function putObjectFile(key: string, file: string, mime: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { createReadStream } = await import('node:fs')
    await (
      await client()
    ).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(file), ContentType: mime }))
    return
  }
  await fs.mkdir(path.dirname(path.join(DISK_DIR, key)), { recursive: true })
  await fs.copyFile(file, path.join(DISK_DIR, key))
}

export async function deleteObject(key: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await (await client()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    return
  }
  await fs.rm(path.join(DISK_DIR, key), { force: true })
}

/** Whether an object exists, without reading its bytes. */
export async function hasObject(key: string): Promise<boolean> {
  assertKey(key)
  if (BUCKET) {
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
      await (await client()).send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
      return true
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false
      throw e
    }
  }
  try {
    return (await fs.stat(path.join(DISK_DIR, key))).isFile()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

export async function getObject(key: string, signal?: AbortSignal): Promise<Buffer | null> {
  assertKey(key)
  if (BUCKET) {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const out = await (
        await client()
      ).send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: signal })
      return Buffer.from(await out.Body!.transformToByteArray())
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null
      throw e
    }
  }
  try {
    return await fs.readFile(path.join(DISK_DIR, key), { signal })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
