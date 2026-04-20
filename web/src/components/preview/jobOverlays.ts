import * as THREE from 'three'
import type { JobSpan } from '@svg2gcode/bridge/viewer'

function jobHue(jobIndex: number): THREE.Color {
  const hue = ((jobIndex * 57) % 360) / 360
  const color = new THREE.Color()
  color.setHSL(hue, 0.75, 0.55)
  return color
}

function makeLabelSprite(text: string, color: THREE.Color): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = `#${color.getHexString()}`
  ctx.beginPath()
  ctx.roundRect?.(4, 4, 248, 56, 10)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 32px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(40, 10, 1)
  sprite.renderOrder = 12
  return sprite
}

export function buildJobOverlays(
  jobs: JobSpan[],
): THREE.Group {
  const group = new THREE.Group()
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const color = jobHue(i + 1)

    const bounds = job.bounds
    if (!bounds) continue
    const ox = job.previewOffset.x
    const oy = job.previewOffset.y
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
    const boundsGeom = new THREE.BufferGeometry().setFromPoints(boundsPts)
    const boundsMat = new THREE.LineDashedMaterial({
      color,
      dashSize: 4,
      gapSize: 3,
      depthTest: false,
    })
    const boundsLine = new THREE.Line(boundsGeom, boundsMat)
    boundsLine.computeLineDistances()
    boundsLine.renderOrder = 11
    group.add(boundsLine)

    const crossX = job.crossOffsetFromArtboardBL.x
    const crossY = job.crossOffsetFromArtboardBL.y
    const crossSize = 6
    const crossPts = [
      new THREE.Vector3(crossX - crossSize, crossY, z),
      new THREE.Vector3(crossX + crossSize, crossY, z),
    ]
    const crossGeomH = new THREE.BufferGeometry().setFromPoints(crossPts)
    const crossGeomV = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(crossX, crossY - crossSize, z),
      new THREE.Vector3(crossX, crossY + crossSize, z),
    ])
    const crossMat = new THREE.LineBasicMaterial({ color, depthTest: false })
    const lineH = new THREE.Line(crossGeomH, crossMat)
    const lineV = new THREE.Line(crossGeomV, crossMat)
    lineH.renderOrder = 11
    lineV.renderOrder = 11
    group.add(lineH, lineV)

    const label = makeLabelSprite(`J${i + 1}`, color)
    label.position.set(crossX + crossSize + 10, crossY + crossSize + 6, z + 1)
    group.add(label)
  }
  return group
}

export function disposeJobOverlays(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    const line = child as THREE.Line
    if (line.geometry && typeof line.geometry.dispose === 'function') {
      line.geometry.dispose()
    }
    const mat = (line.material as THREE.Material | THREE.Material[] | undefined)
    if (Array.isArray(mat)) for (const m of mat) m.dispose()
    else if (mat && typeof mat.dispose === 'function') mat.dispose()
    const sprite = child as THREE.Sprite
    const sMat = sprite.material as THREE.SpriteMaterial | undefined
    if (sMat && sMat.map) sMat.map.dispose()
  }
}
