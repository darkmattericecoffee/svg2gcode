import opentype, { type Font } from 'opentype.js'

export interface GoogleFontFamily {
  family: string
  category: string
  variants: string[]
  files: Record<string, string>
  subsets: string[]
}

const CATALOG_CACHE_KEY = 'googleFontsCatalog.v1'
const CATALOG_STALE_MS = 24 * 60 * 60 * 1000

let catalogPromise: Promise<GoogleFontFamily[]> | null = null

const fontCache = new Map<string, Font>()
const fontPromises = new Map<string, Promise<Font>>()
const registeredFaces = new Set<string>()

function parseVariant(variant: string): { weight: number; style: 'normal' | 'italic' } {
  const italic = /italic/i.test(variant)
  const match = variant.match(/\d+/)
  const weight = match ? Number(match[0]) : 400
  return { weight: weight || 400, style: italic ? 'italic' : 'normal' }
}

function registerFontFace(family: string, variant: string, buffer: ArrayBuffer) {
  const key = cacheKey(family, variant)
  if (registeredFaces.has(key)) return
  if (typeof document === 'undefined' || !('fonts' in document)) return
  const { weight, style } = parseVariant(variant)
  try {
    const face = new FontFace(family, buffer, { weight: String(weight), style })
    face.load().then((loaded) => {
      ;(document as Document & { fonts: FontFaceSet }).fonts.add(loaded)
    }).catch(() => {
      // ignore — generator paths still work
    })
    registeredFaces.add(key)
  } catch {
    // ignore
  }
}

function cacheKey(family: string, variant: string): string {
  return `${family}|${variant}`
}

export function getApiKey(): string | null {
  const key = (import.meta.env.VITE_GOOGLE_FONTS_API_KEY as string | undefined)?.trim()
  return key ? key : null
}

export async function fetchGoogleFontList(): Promise<GoogleFontFamily[]> {
  if (catalogPromise) return catalogPromise

  try {
    const cached = sessionStorage.getItem(CATALOG_CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as { at: number; items: GoogleFontFamily[] }
      if (parsed.items?.length && Date.now() - parsed.at < CATALOG_STALE_MS) {
        catalogPromise = Promise.resolve(parsed.items)
        return catalogPromise
      }
    }
  } catch {
    // fall through to network
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('Missing VITE_GOOGLE_FONTS_API_KEY. Add it to web/.env.local.')
  }

  catalogPromise = (async () => {
    const url = `https://www.googleapis.com/webfonts/v1/webfonts?key=${encodeURIComponent(apiKey)}&sort=popularity`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Google Fonts API error: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as { items?: GoogleFontFamily[] }
    const items = data.items ?? []
    try {
      sessionStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ at: Date.now(), items }))
    } catch {
      // storage full — ignore
    }
    return items
  })()

  try {
    return await catalogPromise
  } catch (err) {
    catalogPromise = null
    throw err
  }
}

/**
 * Sync accessor — returns the font if already loaded, else null.
 * Generators use this to avoid making `runGenerator` async.
 */
export function getCachedFont(family: string, variant: string): Font | null {
  return fontCache.get(cacheKey(family, variant)) ?? null
}

/**
 * Loads a font from the Google Fonts catalog, returning the parsed opentype.Font.
 * Cached by family+variant. Subsequent calls return the same Font instance.
 */
export async function loadGoogleFont(family: string, variant: string): Promise<Font> {
  const key = cacheKey(family, variant)
  const cached = fontCache.get(key)
  if (cached) return cached
  const existing = fontPromises.get(key)
  if (existing) return existing

  const promise = (async () => {
    const list = await fetchGoogleFontList()
    const entry = list.find((f) => f.family === family)
    if (!entry) throw new Error(`Font family not found: ${family}`)
    const fileUrl = entry.files[variant] ?? entry.files.regular ?? Object.values(entry.files)[0]
    if (!fileUrl) throw new Error(`No font file for ${family} / ${variant}`)
    // Google returns http://fonts.gstatic.com — upgrade to https
    const secureUrl = fileUrl.replace(/^http:\/\//, 'https://')
    const res = await fetch(secureUrl)
    if (!res.ok) throw new Error(`Font file fetch failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    const font = opentype.parse(buffer)
    fontCache.set(key, font)
    registerFontFace(family, variant, buffer)
    return font
  })()

  fontPromises.set(key, promise)
  try {
    return await promise
  } catch (err) {
    fontPromises.delete(key)
    throw err
  }
}
