import { useRef, useState, useCallback } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

import { Label, ProgressBar } from '@heroui/react'
import { Canvas } from './Canvas'
import { LayerTree } from './components/LayerTree'
import { LibraryPanel } from './components/library/LibraryPanel'
import { StudioInspector } from './components/StudioInspector'
import { TopBar } from './components/TopBar'
import { PreviewCanvas } from './components/preview/PreviewCanvas'
import { PlaybackTimeline } from './components/preview/PlaybackTimeline'
import { GcodeViewer } from './components/preview/GcodeViewer'
import { useGcodeGeneration } from './hooks/useGcodeGeneration'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { importSvgToScene } from './lib/svgImport'
import { exportProjectSVG } from './lib/svgExport'
import { DEFAULT_MATERIAL, MATERIAL_PRESETS } from './lib/materialPresets'
import type { MaterialPreset } from './lib/materialPresets'
import { useEditorStore } from './store'
import { insertTabs } from './lib/gcodeTabInsertion'
import type { ViewMode } from './types/preview'

type InspectorTab = 'design' | 'material'

function App() {
  const artboard = useEditorStore((state) => state.artboard)
  const nodesById = useEditorStore((state) => state.nodesById)
  const rootIds = useEditorStore((state) => state.rootIds)
  const stagePendingImport = useEditorStore((state) => state.stagePendingImport)
  const placePendingImport = useEditorStore((state) => state.placePendingImport)
  const setImportStatus = useEditorStore((state) => state.setImportStatus)
  const machiningSettings = useEditorStore((state) => state.machiningSettings)
  const setMachiningSettings = useEditorStore((state) => state.setMachiningSettings)
  const setArtboardSize = useEditorStore((state) => state.setArtboardSize)
  const leftPanelTab = useEditorStore((state) => state.leftPanelTab)
  const setLeftPanelTab = useEditorStore((state) => state.setLeftPanelTab)
  const viewMode = useEditorStore((state) => state.preview.viewMode)
  const setViewMode = useEditorStore((state) => state.setViewMode)
  const initPreview = useEditorStore((state) => state.initPreview)
  const initProgress = useEditorStore((state) => state.preview.initProgress)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('design')
  const [projectName, setProjectName] = useState('Untitled project')
  const [materialPreset, setMaterialPreset] = useState<MaterialPreset>(DEFAULT_MATERIAL)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isInitializingPreview, setIsInitializingPreview] = useState(false)

  const isCanvasEmpty = rootIds.length === 0

  const gcode = useGcodeGeneration()

  useKeyboardShortcuts()

  const handleProjectExport = () => {
    const svgString = exportProjectSVG(
      nodesById,
      rootIds,
      artboard,
      machiningSettings,
      materialPreset,
      projectName,
    )
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectName || 'project'}.svg`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const processSvgFile = async (file: File, autoPlace = false) => {
    try {
      const svgText = await file.text()
      const pendingScene = importSvgToScene({
        artboardWidth: artboard.width,
        artboardHeight: artboard.height,
        fileName: file.name,
        svgText,
      })

      // Restore project metadata if this is an Engrav project file
      const meta = pendingScene.projectMetadata
      if (meta) {
        if (meta.projectName) setProjectName(meta.projectName)
        if (meta.artboard) setArtboardSize(meta.artboard)
        if (meta.machiningSettings) setMachiningSettings(meta.machiningSettings)
        if (meta.materialPreset) handleMaterialChange(meta.materialPreset as MaterialPreset)
      } else {
        // Use the SVG filename (without extension) as the project name
        const baseName = file.name.replace(/\.[^.]+$/, '')
        if (baseName) setProjectName(baseName)
      }

      if (autoPlace) {
        stagePendingImport(pendingScene)
        placePendingImport({ x: 0, y: Math.max(0, artboard.height - pendingScene.height) })
      } else {
        stagePendingImport(pendingScene)
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The SVG import failed unexpectedly.'
      setImportStatus({ tone: 'error', message })
    }
  }

  const handleSvgImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!file) return
    await processSvgFile(file, false)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg'),
    )
    if (!file) return
    await processSvgFile(file, true)
  }

  const handleGenerateGcode = async () => {
    await gcode.generate()
  }

  const handleDownloadGcode = () => {
    const state = useEditorStore.getState()
    const { machiningSettings, artboard: ab } = state
    // Prefer preview gcodeText (already has tabs). Fall back to raw gcode with
    // tab insertion applied on the fly so tabs are never silently omitted.
    let text = state.preview.gcodeText ?? gcode.result?.gcode
    if (text && !state.preview.gcodeText && machiningSettings.tabsEnabled) {
      text = insertTabs(text, {
        materialThickness: ab.thickness,
        tabWidth: machiningSettings.tabWidth,
        tabHeight: machiningSettings.tabHeight,
        tabSpacing: machiningSettings.tabSpacing,
      })
    }
    if (text) {
      gcode.downloadGcode(text, `${projectName || 'output'}.gcode`)
    }
  }

  const handleMaterialChange = (preset: MaterialPreset) => {
    setMaterialPreset(preset)
    useEditorStore.getState().setMaterialPreset(preset)

    const presetDef = MATERIAL_PRESETS.find((entry) => entry.id === preset)
    if (presetDef) {
      setMachiningSettings({ defaultDepthMm: presetDef.defaultDepthMm })
    }
  }

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'preview3d' && gcode.result) {
      setIsInitializingPreview(true)
      // Defer so the loading UI can paint, then run async with progress
      setTimeout(async () => {
        await initPreview(gcode.result!)
        setIsInitializingPreview(false)
      }, 0)
    } else {
      setViewMode(mode)
    }
  }, [gcode.result, initPreview, setViewMode])

  const isPreview3d = viewMode === 'preview3d'
  const isPreview2d = viewMode === 'preview2d'

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="hidden"
        onChange={handleSvgImport}
      />

      <Group orientation="horizontal" className="flex-1">
        {/* Left sidebar */}
        <Panel defaultSize="20%" minSize="14%" maxSize="30%">
          <div className="flex h-full flex-col overflow-hidden border-r border-border bg-background">
            {isPreview3d ? (
              <GcodeViewer />
            ) : (
              <>
                {/* Tab strip */}
                <div className="flex shrink-0 border-b border-border">
                  <button
                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${leftPanelTab === 'layers' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setLeftPanelTab('layers')}
                  >
                    Layers
                  </button>
                  <button
                    className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${leftPanelTab === 'library' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setLeftPanelTab('library')}
                  >
                    Library
                  </button>
                </div>
                {/* Panel body */}
                <div className="min-h-0 flex-1 overflow-hidden">
                  {leftPanelTab === 'layers' ? (
                    <LayerTree
                      projectName={projectName}
                      onProjectNameChange={setProjectName}
                      onImportSvg={() => fileInputRef.current?.click()}
                      onExportProject={handleProjectExport}
                    />
                  ) : (
                    <LibraryPanel />
                  )}
                </div>
              </>
            )}
          </div>
        </Panel>

        <Separator className="w-px bg-border transition-colors hover:bg-primary/30" />

        {/* Center: Canvas or 3D Preview */}
        <Panel defaultSize="56%" minSize="36%">
          <div className="relative flex h-full flex-col overflow-hidden bg-background">
            <TopBar
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              onGenerateGcode={handleGenerateGcode}
              onDownloadGcode={handleDownloadGcode}
              isGenerating={gcode.isGenerating}
              progress={gcode.progress}
              hasGcodeResult={!!gcode.result}
              gcodeResult={gcode.result}
              gcodeError={gcode.error}
              onDismissGcode={gcode.reset}
            />
            <div className="min-h-0 flex-1 relative">
              {isInitializingPreview ? (
                <div className="flex h-full items-center justify-center bg-[#232323]">
                  <div className="flex w-72 flex-col gap-3">
                    <ProgressBar value={initProgress ?? 0} maxValue={100} aria-label="Creating 3D CNC preview" className="w-full">
                      <div className="mb-2 flex items-center justify-between">
                        <Label className="text-sm font-medium text-white">Creating 3D CNC preview</Label>
                        <span className="text-xs text-white/60">{initProgress ?? 0}%</span>
                      </div>
                      <ProgressBar.Track className="h-2 overflow-hidden rounded-full bg-white/10">
                        <ProgressBar.Fill className="rounded-full bg-emerald-500" />
                      </ProgressBar.Track>
                    </ProgressBar>
                  </div>
                </div>
              ) : isPreview3d ? (
                <PreviewCanvas />
              ) : (
                <Canvas
                  allowStageSelection={inspectorTab === 'material'}
                  materialPreset={materialPreset}
                  forceEngravePreview={isPreview2d}
                />
              )}

              {/* Empty-state drop zone */}
              {!isPreview3d && !isPreview2d && isCanvasEmpty && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                  <div
                    className={`pointer-events-auto relative flex min-w-[500px] max-w-[80%] flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-12 py-10 text-center backdrop-blur-md transition-all duration-220 ease-out ${
                      isDragOver
                        ? 'translate-y-0 scale-[1.015] border-white/80 bg-black/78 shadow-[0_18px_36px_rgba(0,0,0,0.36)]'
                        : 'translate-y-0 scale-100 border-white/65 bg-black/72 shadow-[0_10px_26px_rgba(0,0,0,0.3)]'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className={`pointer-events-none absolute inset-[6px] rounded-[14px] border border-white/25 transition-opacity duration-200 ${isDragOver ? 'opacity-100' : 'opacity-75'}`} />
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width={isDragOver ? 38 : 40}
                      height={isDragOver ? 38 : 40}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`relative transition-colors duration-200 ${isDragOver ? 'text-primary' : 'text-muted-foreground'}`}
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <div className="relative">
                      <p className="text-base font-semibold text-foreground">
                        {isDragOver ? 'Drop to import SVG' : 'Import or drag an SVG to begin'}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isDragOver ? 'Release to import this file' : 'Drop a file anywhere, or click to browse'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Playback timeline at bottom in 3D preview mode */}
            {isPreview3d && <PlaybackTimeline />}
          </div>
        </Panel>

        <Separator className="w-px bg-border transition-colors hover:bg-primary/30" />

        {/* Right: Studio inspector */}
        <Panel defaultSize="24%" minSize="18%" maxSize="34%">
          <div className="h-full overflow-hidden border-l border-border bg-background">
            <StudioInspector
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              materialPreset={materialPreset}
              onMaterialChange={handleMaterialChange}
            />
          </div>
        </Panel>
      </Group>
    </div>
  )
}

export default App
