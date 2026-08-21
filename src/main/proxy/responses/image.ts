import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import type {
  ChatResponseImage,
  ResolvedResponseImage,
  ResponseImageResolver,
} from './compat.ts'

const DEFAULT_MAX_IMAGE_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 3

type RemoteImageLoaderOptions = {
  signal?: AbortSignal
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
}

export interface ResponseImageResolverOptions {
  signal?: AbortSignal
  maxImageBytes?: number
  maxTotalBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  remoteImageLoader?: (url: URL, options: RemoteImageLoaderOptions) => Promise<Buffer>
}

export class ResponseImageResolutionError extends Error {
  readonly code = 'image_download_failed'
  readonly status = 502

  constructor(message: string) {
    super(message)
    this.name = 'ResponseImageResolutionError'
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base)
  if (baseValue === undefined) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address)
  if (value === undefined) return false
  const blocked = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const
  return !blocked.some(([base, prefix]) => ipv4InCidr(value, base, prefix))
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  let normalized = address.toLowerCase().split('%')[0]
  const dottedIndex = normalized.lastIndexOf(':')
  if (normalized.includes('.') && dottedIndex >= 0) {
    const ipv4 = ipv4Number(normalized.slice(dottedIndex + 1))
    if (ipv4 === undefined) return undefined
    normalized = `${normalized.slice(0, dottedIndex)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined

  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >>> 8
    bytes[index * 2 + 1] = value & 0xff
  })
  return bytes
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address)
  if (!bytes || (bytes[0] & 0xe0) !== 0x20) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false
  if (bytes[0] === 0x3f && bytes[1] === 0xff) return false
  return true
}

export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function imageUrl(image: ChatResponseImage): string | undefined {
  if (typeof image.image_url === 'string') return image.image_url
  if (typeof image.image_url?.url === 'string') return image.image_url.url
  return typeof image.url === 'string' ? image.url : undefined
}

function inferRasterMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (buffer.length >= 12 && buffer.subarray(4, 12).toString('ascii') === 'ftypavif') {
    return 'image/avif'
  }
  return undefined
}

function validateRasterImage(buffer: Buffer, declaredMimeType?: string): Buffer {
  const inferred = inferRasterMimeType(buffer)
  if (!inferred) throw new ResponseImageResolutionError('Generated image has an unsupported raster format.')
  const declared = declaredMimeType?.split(';', 1)[0].trim().toLowerCase()
  const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared
  if (normalizedDeclared?.startsWith('image/') && normalizedDeclared !== inferred) {
    throw new ResponseImageResolutionError('Generated image content does not match its declared media type.')
  }
  return buffer
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  const literalFamily = isIP(unwrapped)
  const records = literalFamily
    ? [{ address: unwrapped, family: literalFamily }]
    : await lookup(unwrapped, { all: true, verbatim: true })
  const selected = records.find(record => isPublicImageAddress(record.address))
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new ResponseImageResolutionError('Generated image URL does not resolve to a public address.')
  }
  return { address: selected.address, family: selected.family }
}

async function downloadPublicHttpsImage(
  url: URL,
  options: RemoteImageLoaderOptions,
  redirectCount = 0,
): Promise<Buffer> {
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) {
    throw new ResponseImageResolutionError('Generated image URL must use public HTTPS on the standard port.')
  }
  if (redirectCount > options.maxRedirects) {
    throw new ResponseImageResolutionError('Generated image URL exceeded the redirect limit.')
  }
  if (options.signal?.aborted) throw new ResponseImageResolutionError('Generated image download was cancelled.')

  const selected = await resolvePublicAddress(url.hostname)
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value ?? Buffer.alloc(0))
    }
    const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET',
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Chat2API image resolver',
      },
      autoSelectFamily: false,
      lookup: (_hostname: string, _lookupOptions: unknown, callback: (...args: any[]) => void) => {
        callback(null, selected.address, selected.family)
      },
    }
    const request = httpsRequest(url, requestOptions, response => {
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location
        response.resume()
        if (!location) {
          finish(new ResponseImageResolutionError('Generated image redirect omitted its location.'))
          return
        }
        let redirectUrl: URL
        try {
          redirectUrl = new URL(location, url)
        } catch {
          finish(new ResponseImageResolutionError('Generated image redirect location is invalid.'))
          return
        }
        void downloadPublicHttpsImage(redirectUrl, options, redirectCount + 1)
          .then(value => finish(undefined, value))
          .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
        return
      }
      if (status !== 200) {
        response.resume()
        finish(new ResponseImageResolutionError(`Generated image download returned HTTP ${status}.`))
        return
      }

      const contentLength = Number(response.headers['content-length'])
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        response.destroy()
        finish(new ResponseImageResolutionError('Generated image exceeds the per-image byte limit.'))
        return
      }

      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += value.length
        if (bytes > options.maxBytes) {
          response.destroy()
          finish(new ResponseImageResolutionError('Generated image exceeds the per-image byte limit.'))
          return
        }
        chunks.push(value)
      })
      response.once('error', error => finish(error))
      response.once('end', () => {
        try {
          finish(undefined, validateRasterImage(
            Buffer.concat(chunks, bytes),
            Array.isArray(response.headers['content-type'])
              ? response.headers['content-type'][0]
              : response.headers['content-type'],
          ))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    const onAbort = () => request.destroy(new ResponseImageResolutionError('Generated image download was cancelled.'))
    const timer = setTimeout(() => {
      request.destroy(new ResponseImageResolutionError('Generated image download timed out.'))
    }, options.timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    request.once('error', error => finish(error))
    request.end()
  })
}

function dataUrlImage(value: string, maxBytes: number): Buffer | undefined {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp|bmp|avif));base64,([a-z0-9+/]+={0,2})$/i.exec(value)
  if (!match) return undefined
  const encoded = match[2]
  if (encoded.length % 4 !== 0 || Buffer.byteLength(encoded, 'base64') > maxBytes) {
    throw new ResponseImageResolutionError('Generated image data URL exceeds the byte limit or has invalid padding.')
  }
  return validateRasterImage(Buffer.from(encoded, 'base64'), match[1])
}

export function createResponseImageResolver(options: ResponseImageResolverOptions = {}): ResponseImageResolver {
  const maxImageBytes = options.maxImageBytes ?? positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_IMAGE_MAX_BYTES',
    DEFAULT_MAX_IMAGE_BYTES,
  )
  const maxTotalBytes = options.maxTotalBytes ?? positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_IMAGE_MAX_TOTAL_BYTES',
    DEFAULT_MAX_TOTAL_BYTES,
  )
  const timeoutMs = options.timeoutMs ?? positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_IMAGE_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  )
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const remoteImageLoader = options.remoteImageLoader ?? downloadPublicHttpsImage
  let consumedBytes = 0
  let queue = Promise.resolve()

  const resolveOne = async (image: ChatResponseImage): Promise<ResolvedResponseImage> => {
    const value = imageUrl(image)
    if (!value) throw new ResponseImageResolutionError('Generated image output omitted its URL or data.')

    let buffer = dataUrlImage(value, maxImageBytes)
    if (!buffer) {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new ResponseImageResolutionError('Generated image output contains an invalid URL.')
      }
      buffer = validateRasterImage(await remoteImageLoader(url, {
        signal: options.signal,
        maxBytes: maxImageBytes,
        timeoutMs,
        maxRedirects,
      }))
    }

    if (buffer.length > maxImageBytes || consumedBytes + buffer.length > maxTotalBytes) {
      throw new ResponseImageResolutionError('Generated images exceed the response byte budget.')
    }
    consumedBytes += buffer.length
    return {
      result: buffer.toString('base64'),
      revised_prompt: image.revised_prompt,
    }
  }

  return (image) => {
    const result = queue.then(() => resolveOne(image))
    queue = result.then(() => undefined, () => undefined)
    return result
  }
}
