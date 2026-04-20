import * as THREE from 'three'
import type { JobSpan } from '@svg2gcode/bridge/viewer'

function jobHue(jobIndex: number): THREE.Color {
  const hue = ((jobIndex * 57) % 360) / 360
  const color = new THREE.Color()
  color.setHSL(hue, 0.75, 0.55)
  return color
}

const GUIDE_LIGHT = new THREE.Color(0x8a8d91)

function pointOrZero(point: { x: number; y: number } | undefined): { x: number; y: number } {
  return {
    x: finiteOrZero(point?.x),
    y: finiteOrZero(point?.y),
  }
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function hasFinitePoint(point: { x: number; y: number } | undefined): boolean {
  return (
    typeof point?.x === 'number' &&
    typeof point?.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  )
}

function makeLabelSprite(
  text: string,
  color: THREE.Color,
  options: { width?: number; height?: number; fontPx?: number; scaleX?: number; scaleY?: number } = {},
): THREE.Sprite {
  const width = options.width ?? 256
  const height = options.height ?? 64
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = `#${color.getHexString()}`
  ctx.beginPath()
  ctx.roundRect?.(4, 4, width - 8, height - 8, 8)
  ctx.fill()
  ctx.fillStyle = '#000000'
  ctx.font = `700 ${options.fontPx ?? 32}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, width / 2, height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(options.scaleX ?? 40, options.scaleY ?? 10, 1)
  sprite.renderOrder = 12
  return sprite
}

function straightLine(
  start: { x: number; y: number },
  end: { x: number; y: number },
  z: number,
  color: THREE.Color = GUIDE_LIGHT,
  opacity = 0.72,
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(start.x, start.y, z),
    new THREE.Vector3(end.x, end.y, z),
  ])
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
  })
  const line = new THREE.Line(geometry, material)
  line.renderOrder = 12
  return line
}

function dashedLine(points: THREE.Vector3[], color: THREE.Color, dashSize = 4, gapSize = 3): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineDashedMaterial({
    color,
    dashSize,
    gapSize,
    depthTest: false,
  })
  const line = new THREE.Line(geometry, material)
  line.computeLineDistances()
  line.renderOrder = 11
  return line
}

export function buildJobOverlays(
  jobs: JobSpan[],
  _material: { width: number; height: number },
): THREE.Group {
  const group = new THREE.Group()
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const color = jobHue(i + 1)

    const bounds = job.bounds
    if (!bounds) continue
    const previewOffset = pointOrZero(job.previewOffset)
    const crossOffset = pointOrZero(job.crossOffsetFromArtboardBL)
    const ox = previewOffset.x
    const oy = previewOffset.y
    const x0 = bounds.minX + ox
    const x1 = bounds.maxX + ox
    const y0 = bounds.minY + oy
    const y1 = bounds.maxY + oy
    const z = 0.5

    const boundsPts = [
      new THREE.Vector3(x0, y0, z),
      new THREE.Vector3(x1, y0, z),
      new THREE.Vector3(x1, y1, z),
      new THREE.Vector3(x0, y1, z),
      new THREE.Vector3(x0, y0, z),
    ]
    group.add(dashedLine(boundsPts, GUIDE_LIGHT))

    const hasPreviewOffset = hasFinitePoint(job.previewOffset)
    const hasCrossOffset = hasFinitePoint(job.crossOffsetFromArtboardBL)
    const crossX = hasPreviewOffset
      ? previewOffset.x
      : hasCrossOffset
        ? crossOffset.x
        : (x0 + x1) / 2
    const crossY = hasPreviewOffset
      ? previewOffset.y
      : hasCrossOffset
        ? crossOffset.y
        : (y0 + y1) / 2

    // L-shaped marking-out lines: from the anchor point running LEFT to the
    // material's left edge (x=0) and DOWN to the bottom edge (y=0). The user
    // sights along these to scribe the pencil-cross on the real stock.
    group.add(
      straightLine({ x: 0, y: crossY }, { x: crossX, y: crossY }, z + 0.08, color, 0.95),
      straightLine({ x: crossX, y: 0 }, { x: crossX, y: crossY }, z + 0.08, color, 0.95),
    )

    // Job badge near the anchor point.
    const label = makeLabelSprite(`J${i + 1}`, color, {
      width: 128, height: 64, fontPx: 36, scaleX: 18, scaleY: 9,
    })
    label.position.set(crossX + 14, crossY + 10, z + 1)
    group.add(label)

    // Two dimensions per job: distance from left, distance from bottom.
    // Placed at the edge-end of each L-line so the user can mark them off
    // directly against the stock's edge.
    const measuredFromLeft = hasCrossOffset ? crossOffset.x : crossX
    const measuredFromBottom = hasCrossOffset ? crossOffset.y : crossY

    const leftDim = makeLabelSprite(
      `${Math.max(0, measuredFromLeft).toFixed(1)} mm from left`,
      color,
      { width: 360, height: 64, fontPx: 26, scaleX: 70, scaleY: 12 },
    )
    // Sit the label just above the horizontal line, near the LEFT edge of the
    // material so the user can read it while sighting the mark against the stock.
    leftDim.position.set(Math.min(40, Math.max(4, crossX - 40)), crossY + 9, z + 1)
    group.add(leftDim)

    const bottomDim = makeLabelSprite(
      `${Math.max(0, measuredFromBottom).toFixed(1)} mm from bottom`,
      color,
      { width: 360, height: 64, fontPx: 26, scaleX: 70, scaleY: 12 },
    )
    // Sit the label just right of the vertical line, near the BOTTOM edge.
    bottomDim.position.set(crossX + 40, Math.min(28, Math.max(4, crossY - 28)), z + 1)
    group.add(bottomDim)
  }
  return group
}

export function disposeJobOverlays(group: THREE.Group): void {
  const disposeNode = (node: THREE.Object3D) => {
    const maybeMesh = node as THREE.Line | THREE.Sprite
    if (maybeMesh.geometry && typeof maybeMesh.geometry.dispose === 'function') {
      maybeMesh.geometry.dispose()
    }
    const mat = (maybeMesh.material as THREE.Material | THREE.Material[] | undefined)
    if (Array.isArray(mat)) for (const m of mat) m.dispose()
    else if (mat && typeof mat.dispose === 'function') mat.dispose()
    const sMat = maybeMesh.material as THREE.SpriteMaterial | undefined
    if (sMat && sMat.map) sMat.map.dispose()
  }

  for (const child of [...group.children]) {
    child.traverse(disposeNode)
    group.remove(child)
  }
}
