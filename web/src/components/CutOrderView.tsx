import { useState } from 'react'
import type { CanvasNode } from '../types/editor'
import type { CutOrderResult } from '../lib/cutOrder'
import type { ComputedJob } from '../lib/jobs'
import { buildLayerCncSummary } from '../lib/layerTreePresentation'
import { LayerCncSummaryTag, LayerPreview } from './LayerTree'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

export function CutOrderView({
  cutOrder,
  nodesById,
  selectedIds,
  defaultDepth,
  onSelect,
  onHover,
  onHoverLeave,
  onContextMenu,
  onReorder,
  onMoveToJob,
  jobs,
  onStartJobAt,
}: {
  cutOrder: CutOrderResult
  nodesById: Record<string, CanvasNode>
  selectedIds: string[]
  defaultDepth: number
  jobs: ComputedJob[]
  onSelect: (id: string, e: React.MouseEvent) => void
  onHover: (id: string) => void
  onHoverLeave: () => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  onReorder: (nextOrder: string[]) => void
  onMoveToJob: (nodeId: string, targetJobId: string, targetNodeId: string, before: boolean) => void
  onStartJobAt: (cutIndex: number) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState(true)

  if (cutOrder.sequence.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-md border border-dashed border-border bg-[var(--surface)] px-3 py-3 text-sm text-muted-foreground">
          Nothing to cut yet. Import an SVG or add a shape to see the order.
        </div>
      </div>
    )
  }

  function handleDrop(targetId: string, targetJobId: string, before: boolean) {
    if (!draggingId || draggingId === targetId) return
    const sourceJobId = jobs.find((job) => job.nodeIds.includes(draggingId))?.id
    if (sourceJobId && sourceJobId !== targetJobId) {
      onMoveToJob(draggingId, targetJobId, targetId, before)
      return
    }
    const ids = cutOrder.sequence.map((l) => l.nodeId)
    const fromIdx = ids.indexOf(draggingId)
    const targetIdx = ids.indexOf(targetId)
    if (fromIdx < 0 || targetIdx < 0) return
    const [moved] = ids.splice(fromIdx, 1)
    const insertIdx = ids.indexOf(targetId) + (before ? 0 : 1)
    ids.splice(insertIdx, 0, moved)
    onReorder(ids)
  }

  function handleSectionDrop(targetJobId: string) {
    if (!draggingId) return
    const section = sections.find((entry) => entry.id === targetJobId)
    const targetLeaf = section?.leaves[section.leaves.length - 1]
    const sourceJobId = jobs.find((job) => job.nodeIds.includes(draggingId))?.id
    if (!targetLeaf || sourceJobId === targetJobId || draggingId === targetLeaf.nodeId) return
    onMoveToJob(draggingId, targetJobId, targetLeaf.nodeId, false)
  }

  const leafById = new Map(cutOrder.sequence.map((leaf) => [leaf.nodeId, leaf]))
  const assigned = new Set<string>()
  const sections = jobs.length > 0
    ? jobs.map((job, index) => {
        const leaves = job.nodeIds
          .map((nodeId) => leafById.get(nodeId))
          .filter((leaf): leaf is typeof cutOrder.sequence[number] => Boolean(leaf))
        for (const leaf of leaves) assigned.add(leaf.nodeId)
        return { id: job.id, name: job.name || `Job ${index + 1}`, leaves }
      }).filter((section) => section.leaves.length > 0)
    : []
  const unassignedLeaves = cutOrder.sequence.filter((leaf) => !assigned.has(leaf.nodeId))
  if (sections.length === 0) {
    sections.push({ id: 'job-all', name: 'Job 1', leaves: cutOrder.sequence })
  } else if (unassignedLeaves.length > 0) {
    sections[sections.length - 1]!.leaves.push(...unassignedLeaves)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="space-y-3">
        {sections.map((section, sectionIndex) => (
          <div
            key={`${section.id}-${section.leaves[0]?.index ?? 0}`}
            className={cn(
              'rounded-md transition-colors',
              dropTargetId === `section:${section.id}` && 'bg-[var(--surface-secondary)]/40',
            )}
            onDragOver={(e) => {
              if (!draggingId) return
              const sourceJobId = jobs.find((job) => job.nodeIds.includes(draggingId))?.id
              if (sourceJobId === section.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTargetId(`section:${section.id}`)
            }}
            onDragLeave={(e) => {
              const related = e.relatedTarget as Node | null
              if (!related || !e.currentTarget.contains(related)) {
                if (dropTargetId === `section:${section.id}`) setDropTargetId(null)
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              handleSectionDrop(section.id)
              setDraggingId(null)
              setDropTargetId(null)
            }}
          >
            <div className="group/job mb-1 flex items-center gap-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span>{`Job ${sectionIndex + 1}`}</span>
              <span className="text-[10px] normal-case tracking-normal text-muted-foreground/70">
                {section.leaves.length} item{section.leaves.length === 1 ? '' : 's'}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-0.5">
              {section.leaves.map((leaf) => {
                const node = nodesById[leaf.nodeId]
                if (!node) return null
                const selected = selectedIds.includes(leaf.nodeId)
                const summary = buildLayerCncSummary(node, nodesById, defaultDepth)
                const isDragging = draggingId === leaf.nodeId
                const isDropTarget = dropTargetId === leaf.nodeId && draggingId && draggingId !== leaf.nodeId
                const groupContext = displayGroupContext(leaf.groupName)
                return (
                  <div key={leaf.nodeId} className="group/marker">
                    {leaf.index > 0 ? (
                      <button
                        type="button"
                        className="mb-0.5 flex h-4 w-full items-center gap-2 rounded px-2 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity hover:bg-[var(--surface-secondary)] hover:text-foreground group-hover/marker:opacity-100"
                        onClick={() => onStartJobAt(leaf.index)}
                        title="Start new job here"
                      >
                        <span className="h-px flex-1 bg-border" />
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-background px-1 leading-none">
                          +
                        </span>
                        <span>Start job here</span>
                        <span className="h-px flex-1 bg-border" />
                      </button>
                    ) : null}
                    <div
                      className={cn(
                        'relative',
                        isDropTarget && dropBefore && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded before:bg-primary',
                        isDropTarget && !dropBefore && 'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded after:bg-primary',
                      )}
                      draggable
                      onDragStart={(e) => {
                        setDraggingId(leaf.nodeId)
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', leaf.nodeId)
                      }}
                      onDragEnd={() => {
                        setDraggingId(null)
                        setDropTargetId(null)
                      }}
                      onDragOver={(e) => {
                        if (!draggingId || draggingId === leaf.nodeId) return
                        e.preventDefault()
                        e.stopPropagation()
                        e.dataTransfer.dropEffect = 'move'
                        const rect = e.currentTarget.getBoundingClientRect()
                        const before = e.clientY < rect.top + rect.height / 2
                        setDropTargetId(leaf.nodeId)
                        setDropBefore(before)
                      }}
                      onDragLeave={(e) => {
                        const related = e.relatedTarget as Node | null
                        if (!related || !e.currentTarget.contains(related)) {
                          if (dropTargetId === leaf.nodeId) setDropTargetId(null)
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleDrop(leaf.nodeId, section.id, dropBefore)
                        setDraggingId(null)
                        setDropTargetId(null)
                      }}
                    >
                      <button
                        type="button"
                        className={cn(
                          'group/row flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)]',
                          selected && 'bg-[var(--surface-tertiary)]',
                          !node.visible && 'opacity-50',
                          isDragging && 'opacity-40',
                        )}
                        onClick={(e) => onSelect(leaf.nodeId, e)}
                        onMouseEnter={() => onHover(leaf.nodeId)}
                        onMouseLeave={onHoverLeave}
                        onContextMenu={(e) => onContextMenu(leaf.nodeId, e)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground"
                            aria-hidden
                          >
                            ⋮⋮
                          </span>
                          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold tabular-nums text-primary">
                            {leaf.index + 1}
                          </span>
                          <LayerPreview node={node} nodesById={nodesById} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{node.name || node.id}</span>
                            {groupContext ? (
                              <span className="block truncate text-[10px] text-muted-foreground/70">
                                {groupContext}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <LayerCncSummaryTag summary={summary} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function displayGroupContext(groupName: string): string | null {
  const normalized = groupName.trim()
  if (!normalized) return null
  if (/^(root|group|svg\s*group|svggroup)$/i.test(normalized)) return null
  return normalized
}
