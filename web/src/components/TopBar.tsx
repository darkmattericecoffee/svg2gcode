import { Button, Label, ProgressBar } from '@heroui/react'
import type { JobProgress, GenerateJobResponse } from '@svg2gcode/bridge'
import ArrowDownToSquareIcon from '@gravity-ui/icons/esm/ArrowDownToSquare.js'
import SparklesIcon from '@gravity-ui/icons/esm/Sparkles.js'

import { AppIcon } from '../lib/icons'
import type { ViewMode } from '../types/preview'

interface TopBarProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
  onGenerateGcode: () => void
  onDownloadGcode: () => void
  isGenerating?: boolean
  progress?: JobProgress | null
  hasGcodeResult?: boolean
  gcodeResult?: GenerateJobResponse | null
  gcodeError?: string | null
  onDismissGcode?: () => void
}

function progressLabel(progress: JobProgress | null | undefined): string {
  if (!progress) return 'Preparing GCode generation…'

  switch (progress.phase) {
    case 'processing': {
      const { current, total } = progress
      if (total > 0) {
        return `Processing operation ${Math.min(current + 1, total)} of ${total}`
      }
      return 'Processing operations…'
    }
    case 'optimizing':
      return 'Optimizing toolpath order…'
    case 'formatting':
      return 'Formatting GCode output…'
    default:
      return 'Generating GCode…'
  }
}

function progressPercent(progress: JobProgress | null | undefined): number {
  if (!progress) return 3

  switch (progress.phase) {
    case 'processing': {
      const { current, total } = progress
      if (total > 0) return Math.max(5, Math.min(85, Math.round((current / total) * 85)))
      return 10
    }
    case 'optimizing':
      return 92
    case 'formatting':
      return 97
    default:
      return 3
  }
}

export function TopBar({
  viewMode,
  onViewModeChange,
  onGenerateGcode,
  onDownloadGcode,
  isGenerating,
  progress,
  hasGcodeResult,
  gcodeResult,
  gcodeError,
  onDismissGcode,
}: TopBarProps) {
  const percent = progressPercent(progress)
  const isExpanded = isGenerating || !!gcodeResult || !!gcodeError

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
      <div className="pointer-events-auto inline-flex flex-col rounded-[1.75rem] border border-white/10 bg-[rgba(19,19,23,0.9)] px-3 py-3 text-white shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl transition-all duration-300">
        <div className="flex min-h-10 items-center gap-3">

          {/* Tabs: Design / Preview / 3D CNC */}
          <div className="flex h-10 items-center rounded-[1.2rem] bg-[#27272A] px-1">
            <button
              type="button"
              className={`flex h-8 min-w-[80px] items-center justify-center rounded-[0.9rem] px-5 text-sm font-medium transition ${
                viewMode === 'design'
                  ? 'bg-[#3f3f46] text-white'
                  : 'text-white/40 hover:text-white/60'
              }`}
              onClick={() => onViewModeChange('design')}
            >
              Design
            </button>
            <button
              type="button"
              className={`flex h-8 min-w-[80px] items-center justify-center rounded-[0.9rem] px-5 text-sm font-medium transition ${
                viewMode === 'preview2d'
                  ? 'bg-[#3f3f46] text-white'
                  : 'text-white/40 hover:text-white/60'
              }`}
              onClick={() => onViewModeChange('preview2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={`flex h-8 min-w-[80px] items-center justify-center rounded-[0.9rem] px-5 text-sm font-medium transition ${
                viewMode === 'preview3d'
                  ? 'bg-[#3f3f46] text-white'
                  : hasGcodeResult
                    ? 'text-white/40 hover:text-white/60'
                    : 'cursor-not-allowed text-white/20'
              }`}
              onClick={() => {
                if (hasGcodeResult) {
                  onViewModeChange('preview3d')
                }
              }}
            >
              3D
            </button>
          </div>

          {/* Generate GCode — immediately after tabs */}
          <Button
            className="rounded-full bg-emerald-600 text-[14px] font-medium text-white hover:bg-emerald-500 px-3 gap-1.5"
            size="sm"
            isDisabled={isGenerating}
            onPress={onGenerateGcode}
          >
            <AppIcon icon={SparklesIcon} className="h-4 w-4" />
            Make GCode
          </Button>
          <Button
            className="rounded-full bg-emerald-600 px-3 gap-1.5 text-[14px] font-medium text-white hover:bg-emerald-500 disabled:bg-emerald-900/40 disabled:text-white/35"
            size="sm"
            isDisabled={isGenerating || !hasGcodeResult}
            onPress={onDownloadGcode}
          >
            <AppIcon icon={ArrowDownToSquareIcon} className="h-4 w-4" />
            Download
          </Button>
        </div>

        {/* Expandable status area */}
        {isExpanded && (
          <div className="mt-3 border-t border-white/10 pt-3">
            {isGenerating && (
              <ProgressBar aria-label="GCode generation progress" className="w-full" value={percent}>
                <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                  <Label className="text-sm font-medium text-white">{progressLabel(progress)}</Label>
                  <ProgressBar.Output className="text-xs text-white/60" />
                </div>
                <ProgressBar.Track className="h-2 overflow-hidden rounded-full bg-white/10">
                  <ProgressBar.Fill className="rounded-full bg-emerald-500 transition-all duration-300" />
                </ProgressBar.Track>
              </ProgressBar>
            )}

            {!isGenerating && gcodeResult && (
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5 min-w-0">
                  <p className="text-sm font-medium text-emerald-400">GCode generated</p>
                  <p className="text-xs text-white/50">
                    {gcodeResult.gcode.split('\n').length.toLocaleString()} lines
                    {' · '}
                    {gcodeResult.operation_ranges.length} operation{gcodeResult.operation_ranges.length !== 1 ? 's' : ''}
                  </p>
                  {gcodeResult.warnings.length > 0 && (
                    <div className="mt-1 rounded-lg bg-yellow-500/10 px-2.5 py-2">
                      <p className="mb-0.5 text-xs font-medium text-yellow-400">Warnings</p>
                      {gcodeResult.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-yellow-200/70">{w}</p>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-full text-[13px] text-white"
                  variant="secondary"
                  onPress={onDismissGcode}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {!isGenerating && gcodeError && (
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-red-400">Generation failed</p>
                  <p className="text-xs text-white/50">{gcodeError}</p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-full text-[13px] text-white"
                  variant="secondary"
                  onPress={onDismissGcode}
                >
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
