/**
 * Numbered cut-order badges.
 *
 * One THREE.Sprite per toolpath group, positioned at the start of the first
 * cut segment. Each badge is a canvas-painted circle tinted by the incoming
 * rapid distance when the full parsed segment list is available. Sprites face
 * the camera and expose the seek distance via `userData.seekDistance` so click
 * handlers can jump playback there.
 */

import * as THREE from 'three'
import type { ParsedSegment } from '@svg2gcode/bridge/viewer'
import type { ToolpathGroup } from '../../types/preview'
import {
  createRapidMoveColorScale,
  incomingRapidDistanceForCut,
  rapidDistanceCssColor,
} from './rapidMoveColors'

const BADGE_SIZE_PX = 128
const WORLD_SIZE = 8

function hexFromNumberOrString(color: string | number | undefined, fallback = '#ff4d6d'): string {
  if (typeof color === 'number') {
    return `#${color.toString(16).padStart(6, '0')}`
  }
  if (typeof color === 'string' && color.length > 0) {
    return color
  }
  return fallback
}

function drawBadge(label: string, fillCss: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = BADGE_SIZE_PX
  canvas.height = BADGE_SIZE_PX
  const ctx = canvas.getContext('2d')!

  const cx = BADGE_SIZE_PX / 2
  const cy = BADGE_SIZE_PX / 2
  const r = BADGE_SIZE_PX / 2 - 6

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = fillCss
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.stroke()

  ctx.fillStyle = '#ffffff'
  const fontSize = label.length >= 5 ? 32 : label.length >= 3 ? 48 : 64
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0,0,0,0.8)'
  ctx.strokeText(label, cx, cy)
  ctx.fillText(label, cx, cy)

  return canvas
}

function jobHueCss(jobIndex: number): string {
  return `hsl(${(jobIndex * 57) % 360}, 75%, 55%)`
}

export interface CutOrderLabel {
  sprite: THREE.Sprite
  seekDistance: number
}

export function buildCutOrderLabels(
  toolpaths: ToolpathGroup[],
  allSegments: ParsedSegment[] = [],
): {
  group: THREE.Group
  sprites: THREE.Sprite[]
} {
  const group = new THREE.Group()
  const sprites: THREE.Sprite[] = []
  const rapidColorScale = allSegments.length > 0
    ? createRapidMoveColorScale(allSegments)
    : null

  const jobIdOrder: string[] = []
  for (const s of allSegments) {
    const jid = s.jobId ?? null
    if (jid && !jobIdOrder.includes(jid)) jobIdOrder.push(jid)
  }
  const hasMultipleJobs = jobIdOrder.length > 1
  const perJobCounter = new Map<string, number>()

  let visibleIndex = 0
  for (const tp of toolpaths) {
    // Anchor on the first segment that actually cuts material.
    const firstCut = tp.segments.find((s) => s.motionKind === 'cut') ?? tp.segments[0]
    if (!firstCut) continue
    visibleIndex += 1

    const jobId = firstCut.jobId ?? null
    const jobIndex = jobId ? jobIdOrder.indexOf(jobId) + 1 : 0
    let labelText = String(visibleIndex)
    if (hasMultipleJobs && jobIndex > 0) {
      const next = (perJobCounter.get(jobId!) ?? 0) + 1
      perJobCounter.set(jobId!, next)
      labelText = `J${jobIndex}·${next}`
    }

    const incomingRapidDistance = rapidColorScale
      ? incomingRapidDistanceForCut(firstCut, allSegments)
      : 0
    const fill = hasMultipleJobs && jobIndex > 0
      ? jobHueCss(jobIndex)
      : rapidColorScale
        ? rapidDistanceCssColor(incomingRapidDistance, rapidColorScale)
        : hexFromNumberOrString(firstCut.operationColor ?? undefined)
    const canvas = drawBadge(labelText, fill)
    const texture = new THREE.CanvasTexture(canvas)
    texture.anisotropy = 4
    texture.needsUpdate = true

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set(WORLD_SIZE, WORLD_SIZE, 1)
    sprite.position.set(firstCut.start.x, firstCut.start.y, firstCut.start.z + 1)
    sprite.renderOrder = 10
    sprite.userData.seekDistance = firstCut.cumulativeDistanceStart
    sprite.userData.cutOrderIndex = visibleIndex
    sprite.userData.incomingRapidDistance = incomingRapidDistance
    sprite.userData.jobId = jobId
    sprite.userData.jobIndex = jobIndex
    sprite.userData.labelText = labelText

    group.add(sprite)
    sprites.push(sprite)
  }

  return { group, sprites }
}

export function disposeCutOrderLabels(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    const sprite = child as THREE.Sprite
    const material = sprite.material as THREE.SpriteMaterial | undefined
    if (material) {
      material.map?.dispose()
      material.dispose()
    }
  }
}
