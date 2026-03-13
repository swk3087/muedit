"use client";

import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  startTransition,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./audio-editor.module.css";
import { WaveformPreview } from "./waveform-preview";
import {
  assignClipLanes,
  audioBufferToWav,
  createAudioSource,
  createClipFromSource,
  createSilenceClip,
  duplicateClip,
  formatTime,
  getProjectDuration,
  getRulerStep,
  getSnapStep,
  normalizeClip,
  scheduleClipEnvelope,
  snapTime,
  splitClip,
  type AudioSource,
  type Clip,
  MIN_CLIP_DURATION,
} from "@/lib/audio-editor";

type DragState =
  | { mode: "move"; clipId: string; originX: number; originStart: number }
  | {
      mode: "trim-start";
      clipId: string;
      originX: number;
      originStart: number;
      originDuration: number;
      originSourceStart: number;
    }
  | {
      mode: "trim-end";
      clipId: string;
      originX: number;
      originDuration: number;
      originSourceStart: number;
    }
  | { mode: "scrub" };

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AudioEditor() {
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(112);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [silenceLength, setSilenceLength] = useState(2);
  const [statusText, setStatusText] = useState(
    "음악을 올리면 바로 클립으로 배치됩니다. 스페이스 재생, S 분할, Delete 삭제.",
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const isPlayingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const liveHandlersRef = useRef<{
    tickPlayback: () => void;
    handleGlobalPointerMove: (event: PointerEvent) => void;
    handleGlobalPointerUp: () => void;
    handleGlobalKeydown: (event: KeyboardEvent) => void;
  }>({
    tickPlayback: () => {},
    handleGlobalPointerMove: () => {},
    handleGlobalPointerUp: () => {},
    handleGlobalKeydown: () => {},
  });
  const playbackRef = useRef({
    contextStart: 0,
    playheadStart: 0,
    totalDuration: 0,
  });

  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  const selectedSource =
    selectedClip?.kind === "audio"
      ? sources.find((source) => source.id === selectedClip.sourceId) ?? null
      : null;
  const lanes = assignClipLanes(clips);
  const orderedClips = [...clips].sort(
    (left, right) => left.startTime - right.startTime || left.duration - right.duration,
  );
  const arrangementDuration = Math.max(18, getProjectDuration(clips) + 4, playhead + 4);
  const rulerStep = getRulerStep(zoom);
  const timelineWidth = Math.max(arrangementDuration * zoom, 1080);
  const rulerMarks = Array.from(
    { length: Math.ceil(arrangementDuration / rulerStep) + 1 },
    (_, index) => index * rulerStep,
  );

  function snapOffset(value: number) {
    if (!snapEnabled) {
      return value;
    }

    const step = getSnapStep(zoom);
    return Math.round(value / step) * step;
  }

  function ensureAudioContext() {
    if (audioContextRef.current) {
      return audioContextRef.current;
    }

    const scopedWindow = window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextCtor =
      scopedWindow.AudioContext ?? scopedWindow.webkitAudioContext;

    if (!AudioContextCtor) {
      throw new Error("이 브라우저는 Web Audio API를 지원하지 않습니다.");
    }

    audioContextRef.current = new AudioContextCtor();
    return audioContextRef.current;
  }

  function stopPlayback(nextPosition?: number) {
    isPlayingRef.current = false;

    for (const node of activeSourcesRef.current) {
      try {
        node.stop();
      } catch {
        // Nodes may already have ended.
      }
    }

    activeSourcesRef.current = [];

    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    setIsPlaying(false);

    if (typeof nextPosition === "number") {
      setPlayhead(Math.max(0, nextPosition));
    }
  }

  function updateClip(clipId: string, updater: (clip: Clip) => Clip | null) {
    setClips((current) =>
      current.flatMap((clip) => {
        if (clip.id !== clipId) {
          return [clip];
        }

        const next = updater(clip);

        if (!next) {
          return [];
        }

        const source =
          next.kind === "audio"
            ? sources.find((candidate) => candidate.id === next.sourceId) ?? null
            : null;

        return [normalizeClip(next, source)];
      }),
    );
  }

  function insertSourceClip(source: AudioSource, startAt = playhead) {
    const clip = normalizeClip(
      createClipFromSource(source, snapTime(startAt, zoom, snapEnabled)),
      source,
    );

    setClips((current) => [...current, clip]);
    setSelectedClipId(clip.id);
    setStatusText(`${source.name} 클립을 타임라인에 올렸습니다.`);
  }

  async function handleImportFiles(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    stopPlayback();
    setStatusText(`불러오는 중... ${fileList.length}개 파일`);

    const context = ensureAudioContext();
    const importedSources: AudioSource[] = [];
    const importedClips: Clip[] = [];
    const failedFiles: string[] = [];
    let cursor = Math.max(playhead, getProjectDuration(clips));

    for (const file of Array.from(fileList)) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
        const source = createAudioSource(file.name, decoded);
        const clip = normalizeClip(createClipFromSource(source, cursor), source);

        importedSources.push(source);
        importedClips.push(clip);
        cursor += clip.duration + 0.2;
      } catch {
        failedFiles.push(file.name);
      }
    }

    startTransition(() => {
      if (importedSources.length) {
        setSources((current) => [...current, ...importedSources]);
      }

      if (importedClips.length) {
        setClips((current) => [...current, ...importedClips]);
        setSelectedClipId(importedClips.at(-1)?.id ?? null);
        setPlayhead(importedClips[0].startTime);
      }
    });

    if (failedFiles.length === 0) {
      setStatusText(`${importedClips.length}개 파일을 배치했습니다.`);
      return;
    }

    setStatusText(`일부 파일은 읽지 못했습니다: ${failedFiles.join(", ")}`);
  }

  async function handleExport() {
    if (!clips.length) {
      setStatusText("내보낼 클립이 없습니다.");
      return;
    }

    setIsExporting(true);
    stopPlayback();

    try {
      const sampleRate = Math.max(
        48000,
        ...sources.map((source) => source.buffer.sampleRate),
      );
      const channelCount = Math.max(
        2,
        ...sources.map((source) => source.buffer.numberOfChannels),
      );
      const totalDuration = Math.max(0.5, getProjectDuration(clips));
      const frameCount = Math.ceil(totalDuration * sampleRate);
      const offlineContext = new OfflineAudioContext(
        channelCount,
        frameCount,
        sampleRate,
      );

      for (const clip of clips) {
        if (clip.kind !== "audio") {
          continue;
        }

        const source = sources.find((candidate) => candidate.id === clip.sourceId);

        if (!source) {
          continue;
        }

        const bufferSource = offlineContext.createBufferSource();
        const gainNode = offlineContext.createGain();
        bufferSource.buffer = source.buffer;
        bufferSource.connect(gainNode);
        gainNode.connect(offlineContext.destination);
        scheduleClipEnvelope(gainNode.gain, clip, clip.startTime);
        bufferSource.start(clip.startTime, clip.sourceStart, clip.duration);
      }

      const rendered = await offlineContext.startRendering();
      const wavFile = audioBufferToWav(rendered);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadBlob(wavFile, `muedit-export-${stamp}.wav`);
      setStatusText(
        `무손실 WAV로 내보냈습니다. ${rendered.sampleRate}Hz / ${rendered.numberOfChannels}ch`,
      );
    } catch (error) {
      setStatusText(
        error instanceof Error ? error.message : "내보내기 중 오류가 발생했습니다.",
      );
    } finally {
      setIsExporting(false);
    }
  }

  async function startPlayback() {
    if (!clips.length) {
      setStatusText("재생할 클립이 없습니다.");
      return;
    }

    stopPlayback();

    try {
      const context = ensureAudioContext();
      await context.resume();
      const projectDuration = getProjectDuration(clips);
      const startPosition = playhead >= projectDuration ? 0 : playhead;
      const transportStart = context.currentTime + 0.04;

      playbackRef.current = {
        contextStart: transportStart,
        playheadStart: startPosition,
        totalDuration: projectDuration,
      };

      for (const clip of clips) {
        const clipEnd = clip.startTime + clip.duration;

        if (clip.kind !== "audio" || clipEnd <= startPosition) {
          continue;
        }

        const source = sources.find((candidate) => candidate.id === clip.sourceId);

        if (!source) {
          continue;
        }

        const sourceNode = context.createBufferSource();
        const gainNode = context.createGain();
        const offsetWithinClip = Math.max(0, startPosition - clip.startTime);
        const startAt = transportStart + Math.max(0, clip.startTime - startPosition);

        sourceNode.buffer = source.buffer;
        sourceNode.connect(gainNode);
        gainNode.connect(context.destination);
        scheduleClipEnvelope(gainNode.gain, clip, startAt, offsetWithinClip);
        sourceNode.start(
          startAt,
          clip.sourceStart + offsetWithinClip,
          clip.duration - offsetWithinClip,
        );
        activeSourcesRef.current.push(sourceNode);
      }

      isPlayingRef.current = true;
      setPlayhead(startPosition);
      setIsPlaying(true);
      setStatusText("재생 중");
    } catch (error) {
      setStatusText(
        error instanceof Error ? error.message : "재생을 시작하지 못했습니다.",
      );
    }
  }

  function tickPlayback() {
    const context = audioContextRef.current;

    if (!context || !isPlayingRef.current) {
      return;
    }

    const elapsed = context.currentTime - playbackRef.current.contextStart;
    const nextPosition = playbackRef.current.playheadStart + elapsed;

    if (nextPosition >= playbackRef.current.totalDuration) {
      stopPlayback(playbackRef.current.totalDuration);
      return;
    }

    setPlayhead(nextPosition);
  }

  function handleGlobalPointerMove(event: PointerEvent) {
    const dragState = dragRef.current;

    if (!dragState) {
      return;
    }

    if (dragState.mode === "scrub") {
      const timeline = timelineRef.current;

      if (!timeline) {
        return;
      }

      const bounds = timeline.getBoundingClientRect();
      const position = (event.clientX - bounds.left) / zoom;
      setPlayhead(snapTime(position, zoom, snapEnabled));
      return;
    }

    const delta = (event.clientX - dragState.originX) / zoom;
    const snappedDelta = snapOffset(delta);

    updateClip(dragState.clipId, (clip) => {
      const source =
        clip.kind === "audio"
          ? sources.find((candidate) => candidate.id === clip.sourceId) ?? null
          : null;

      if (dragState.mode === "move") {
        return {
          ...clip,
          startTime: snapTime(
            dragState.originStart + snappedDelta,
            zoom,
            snapEnabled,
          ),
        };
      }

      if (dragState.mode === "trim-start") {
        const maxLeftExtension =
          clip.kind === "audio"
            ? -Math.min(dragState.originSourceStart, dragState.originStart)
            : -dragState.originStart;
        const safeDelta = Math.min(
          Math.max(snappedDelta, maxLeftExtension),
          dragState.originDuration - MIN_CLIP_DURATION,
        );

        return normalizeClip(
          {
            ...clip,
            startTime: dragState.originStart + safeDelta,
            duration: dragState.originDuration - safeDelta,
            sourceStart:
              clip.kind === "audio"
                ? dragState.originSourceStart + safeDelta
                : 0,
          },
          source,
        );
      }

      const maxDuration =
        clip.kind === "audio" && source
          ? source.duration - dragState.originSourceStart
          : dragState.originDuration + 300;

      return {
        ...clip,
        duration: Math.min(
          Math.max(MIN_CLIP_DURATION, dragState.originDuration + snappedDelta),
          maxDuration,
        ),
      };
    });
  }

  function handleGlobalPointerUp() {
    dragRef.current = null;
    document.body.style.cursor = "";
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const isTyping =
      target?.closest("input, textarea, select") !== null ||
      target?.isContentEditable === true;

    if (isTyping) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();

      if (isPlayingRef.current) {
        stopPlayback();
      } else {
        void startPlayback();
      }
    }

    if ((event.key === "Delete" || event.key === "Backspace") && selectedClipId) {
      event.preventDefault();
      stopPlayback();
      setClips((current) => current.filter((clip) => clip.id !== selectedClipId));
      setSelectedClipId(null);
      setStatusText("선택한 클립을 삭제했습니다.");
    }

    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      handleSplit();
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPlayhead((current) => Math.max(0, current - (event.shiftKey ? 1 : 0.1)));
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setPlayhead((current) => current + (event.shiftKey ? 1 : 0.1));
    }
  }

  liveHandlersRef.current = {
    tickPlayback,
    handleGlobalPointerMove,
    handleGlobalPointerUp,
    handleGlobalKeydown,
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) =>
      liveHandlersRef.current.handleGlobalPointerMove(event);
    const onPointerUp = () => liveHandlersRef.current.handleGlobalPointerUp();
    const onKeydown = (event: KeyboardEvent) =>
      liveHandlersRef.current.handleGlobalKeydown(event);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeydown);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeydown);
      stopPlayback();
    };
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    const loop = () => {
      liveHandlersRef.current.tickPlayback();

      if (isPlayingRef.current) {
        rafRef.current = window.requestAnimationFrame(loop);
      }
    };

    rafRef.current = window.requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying]);

  function handleTimelinePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    stopPlayback();
    const timeline = timelineRef.current;

    if (!timeline) {
      return;
    }

    const bounds = timeline.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / zoom;
    setPlayhead(snapTime(position, zoom, snapEnabled));
    dragRef.current = { mode: "scrub" };
    document.body.style.cursor = "ew-resize";
  }

  function handleClipPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    clip: Clip,
  ) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    stopPlayback();
    setSelectedClipId(clip.id);
    dragRef.current = {
      mode: "move",
      clipId: clip.id,
      originX: event.clientX,
      originStart: clip.startTime,
    };
    document.body.style.cursor = "grabbing";
  }

  function handleTrimPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    clip: Clip,
    edge: "start" | "end",
  ) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    stopPlayback();
    setSelectedClipId(clip.id);
    document.body.style.cursor = "ew-resize";

    if (edge === "start") {
      dragRef.current = {
        mode: "trim-start",
        clipId: clip.id,
        originX: event.clientX,
        originStart: clip.startTime,
        originDuration: clip.duration,
        originSourceStart: clip.sourceStart,
      };
      return;
    }

    dragRef.current = {
      mode: "trim-end",
      clipId: clip.id,
      originX: event.clientX,
      originDuration: clip.duration,
      originSourceStart: clip.sourceStart,
    };
  }

  function handleSplit() {
    const targetClip =
      selectedClip &&
      playhead > selectedClip.startTime &&
      playhead < selectedClip.startTime + selectedClip.duration
        ? selectedClip
        : clips.find(
            (clip) => playhead > clip.startTime && playhead < clip.startTime + clip.duration,
          ) ?? null;

    if (!targetClip) {
      setStatusText("플레이헤드가 놓인 클립이 없습니다.");
      return;
    }

    const source =
      targetClip.kind === "audio"
        ? sources.find((candidate) => candidate.id === targetClip.sourceId) ?? null
        : null;
    const splitResult = splitClip(targetClip, playhead, source);

    if (!splitResult) {
      setStatusText("분할할 위치가 너무 가장자리입니다.");
      return;
    }

    stopPlayback();
    setClips((current) =>
      current.flatMap((clip) => (clip.id === targetClip.id ? [...splitResult] : [clip])),
    );
    setSelectedClipId(splitResult[1].id);
    setStatusText("클립을 두 조각으로 나눴습니다.");
  }

  function handleDeleteSelected() {
    if (!selectedClip) {
      setStatusText("먼저 클립을 선택하세요.");
      return;
    }

    stopPlayback();
    setClips((current) => current.filter((clip) => clip.id !== selectedClip.id));
    setSelectedClipId(null);
    setStatusText("선택한 클립을 삭제했습니다.");
  }

  function handleDuplicateSelected() {
    if (!selectedClip) {
      setStatusText("먼저 클립을 선택하세요.");
      return;
    }

    const copy = duplicateClip(selectedClip, selectedSource);
    setClips((current) => [...current, copy]);
    setSelectedClipId(copy.id);
    setStatusText("선택한 클립을 복제했습니다.");
  }

  function handleAddSilence() {
    const clip = createSilenceClip(
      snapTime(playhead, zoom, snapEnabled),
      Math.max(0.25, silenceLength),
    );

    setClips((current) => [...current, clip]);
    setSelectedClipId(clip.id);
    setStatusText(`무음 ${clip.duration.toFixed(2)}초를 추가했습니다.`);
  }

  function handleClipNumberChange(
    key: "startTime" | "duration" | "sourceStart" | "fadeIn" | "fadeOut" | "gain",
    rawValue: string,
  ) {
    if (!selectedClip) {
      return;
    }

    const nextValue = Number(rawValue);

    if (Number.isNaN(nextValue)) {
      return;
    }

    updateClip(selectedClip.id, (clip) => ({
      ...clip,
      [key]: nextValue,
    }));
  }

  return (
    <main className={styles.shell}>
      <section className={styles.masthead}>
        <div className={styles.brandBlock}>
          <p className={styles.eyebrow}>BROWSER CUT ROOM</p>
          <h1 className={styles.title}>MUEdit</h1>
          <p className={styles.summary}>
            가져온 오디오를 클립 단위로 자르고, 무음 공간을 만들고, 페이드와
            볼륨을 각 조각마다 따로 만지는 웹 편집기입니다. 마지막은 무손실 WAV로
            바로 내보냅니다.
          </p>
        </div>

        <div className={styles.statsRow}>
          <article className={styles.statCard}>
            <span>Timeline</span>
            <strong>{formatTime(getProjectDuration(clips))}</strong>
          </article>
          <article className={styles.statCard}>
            <span>Sources</span>
            <strong>{sources.length}</strong>
          </article>
          <article className={styles.statCard}>
            <span>Clips</span>
            <strong>{clips.length}</strong>
          </article>
          <article className={styles.statCard}>
            <span>Export</span>
            <strong>32-bit float WAV</strong>
          </article>
        </div>
      </section>

      <section className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardLabel}>Session</span>
              <strong>Start clean, cut fast</strong>
            </div>

            <div className={styles.actionStack}>
              <input
                accept="audio/*"
                className="sr-only"
                multiple
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  void handleImportFiles(event.target.files);
                  event.target.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />

              <button
                className={styles.primaryButton}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                음악 불러오기
              </button>

              <div className={styles.inlineCluster}>
                <label className={styles.field}>
                  <span>무음 길이</span>
                  <input
                    min={0.25}
                    onChange={(event) => setSilenceLength(Number(event.target.value))}
                    step={0.25}
                    type="number"
                    value={silenceLength}
                  />
                </label>

                <button
                  className={styles.secondaryButton}
                  onClick={handleAddSilence}
                  type="button"
                >
                  빈 공간 추가
                </button>
              </div>

              <div className={styles.inlineCluster}>
                <button
                  className={styles.ghostButton}
                  onClick={() => {
                    if (isPlaying) {
                      stopPlayback();
                    } else {
                      void startPlayback();
                    }
                  }}
                  type="button"
                >
                  {isPlaying ? "정지" : "재생"}
                </button>

                <button
                  className={styles.secondaryButton}
                  disabled={isExporting}
                  onClick={() => void handleExport()}
                  type="button"
                >
                  {isExporting ? "렌더링 중..." : "최고음질 WAV 내보내기"}
                </button>
              </div>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardLabel}>Selected Clip</span>
              <strong>{selectedClip ? selectedClip.name : "없음"}</strong>
            </div>

            {selectedClip ? (
              <div className={styles.inspector}>
                <label className={styles.field}>
                  <span>이름</span>
                  <input
                    onChange={(event) =>
                      updateClip(selectedClip.id, (clip) => ({
                        ...clip,
                        name: event.target.value,
                      }))
                    }
                    type="text"
                    value={selectedClip.name}
                  />
                </label>

                <div className={styles.grid}>
                  <label className={styles.field}>
                    <span>시작</span>
                    <input
                      onChange={(event) =>
                        handleClipNumberChange("startTime", event.target.value)
                      }
                      step={0.05}
                      type="number"
                      value={Number(selectedClip.startTime.toFixed(2))}
                    />
                  </label>

                  <label className={styles.field}>
                    <span>길이</span>
                    <input
                      onChange={(event) =>
                        handleClipNumberChange("duration", event.target.value)
                      }
                      step={0.05}
                      type="number"
                      value={Number(selectedClip.duration.toFixed(2))}
                    />
                  </label>
                </div>

                {selectedClip.kind === "audio" && (
                  <label className={styles.field}>
                    <span>원본 시작점</span>
                    <input
                      onChange={(event) =>
                        handleClipNumberChange("sourceStart", event.target.value)
                      }
                      step={0.05}
                      type="number"
                      value={Number(selectedClip.sourceStart.toFixed(2))}
                    />
                  </label>
                )}

                <label className={styles.field}>
                  <span>볼륨 {Math.round(selectedClip.gain * 100)}%</span>
                  <input
                    max={2.5}
                    min={0}
                    onChange={(event) =>
                      handleClipNumberChange("gain", event.target.value)
                    }
                    step={0.01}
                    type="range"
                    value={selectedClip.gain}
                  />
                </label>

                <div className={styles.grid}>
                  <label className={styles.field}>
                    <span>Fade in</span>
                    <input
                      max={selectedClip.duration}
                      min={0}
                      onChange={(event) =>
                        handleClipNumberChange("fadeIn", event.target.value)
                      }
                      step={0.01}
                      type="range"
                      value={selectedClip.fadeIn}
                    />
                    <small>{selectedClip.fadeIn.toFixed(2)}s</small>
                  </label>

                  <label className={styles.field}>
                    <span>Fade out</span>
                    <input
                      max={selectedClip.duration}
                      min={0}
                      onChange={(event) =>
                        handleClipNumberChange("fadeOut", event.target.value)
                      }
                      step={0.01}
                      type="range"
                      value={selectedClip.fadeOut}
                    />
                    <small>{selectedClip.fadeOut.toFixed(2)}s</small>
                  </label>
                </div>

                <div className={styles.inlineCluster}>
                  <button
                    className={styles.ghostButton}
                    onClick={handleSplit}
                    type="button"
                  >
                    현재 위치로 컷
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={handleDuplicateSelected}
                    type="button"
                  >
                    복제
                  </button>
                  <button
                    className={styles.dangerButton}
                    onClick={handleDeleteSelected}
                    type="button"
                  >
                    삭제
                  </button>
                </div>
              </div>
            ) : (
              <p className={styles.emptyCopy}>
                타임라인에서 클립을 하나 선택하면 이름, 볼륨, 페이드, 길이와
                시작 위치를 바로 조정할 수 있습니다.
              </p>
            )}
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardLabel}>Source Shelf</span>
              <strong>{sources.length ? "다시 배치 가능" : "아직 비어 있음"}</strong>
            </div>

            {sources.length ? (
              <div className={styles.sourceList}>
                {sources.map((source) => (
                  <article className={styles.sourceItem} key={source.id}>
                    <div>
                      <strong>{source.name}</strong>
                      <small>{formatTime(source.duration)}</small>
                    </div>
                    <button
                      className={styles.ghostButton}
                      onClick={() => insertSourceClip(source)}
                      type="button"
                    >
                      플레이헤드에 추가
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.emptyCopy}>
                소스 파일은 한 번 올린 뒤 여러 번 잘라 써도 됩니다.
              </p>
            )}
          </div>
        </aside>

        <section className={styles.editor}>
          <div className={styles.transport}>
            <div className={styles.transportLeft}>
              <button
                className={styles.primaryButton}
                onClick={() => {
                  if (isPlaying) {
                    stopPlayback();
                  } else {
                    void startPlayback();
                  }
                }}
                type="button"
              >
                {isPlaying ? "정지" : "재생"}
              </button>

              <button
                className={styles.ghostButton}
                onClick={() => setPlayhead(0)}
                type="button"
              >
                처음으로
              </button>
            </div>

            <div className={styles.transportReadout}>
              <span>Playhead</span>
              <strong>{formatTime(playhead)}</strong>
              <small>/ {formatTime(getProjectDuration(clips))}</small>
            </div>

            <div className={styles.transportRight}>
              <label className={styles.switch}>
                <input
                  checked={snapEnabled}
                  onChange={() => setSnapEnabled((current) => !current)}
                  type="checkbox"
                />
                <span>Snap</span>
              </label>

              <label className={styles.zoomField}>
                <span>Zoom</span>
                <input
                  max={260}
                  min={48}
                  onChange={(event) => setZoom(Number(event.target.value))}
                  step={1}
                  type="range"
                  value={zoom}
                />
              </label>
            </div>
          </div>

          <div className={styles.statusBar}>
            <span
              className={
                isPlaying || isExporting
                  ? `${styles.statusDot} ${styles.statusDotLive}`
                  : styles.statusDot
              }
            />
            <span>{statusText}</span>
          </div>

          <div className={styles.timelineShell}>
            <div className={styles.timelineScroller}>
              <div
                className={styles.timeline}
                onPointerDown={handleTimelinePointerDown}
                ref={timelineRef}
                style={{ width: `${timelineWidth}px` }}
              >
                <div className={styles.ruler}>
                  {rulerMarks.map((mark) => (
                    <div
                      className={styles.rulerMark}
                      key={mark}
                      style={{ left: `${mark * zoom}px` }}
                    >
                      <span>{formatTime(mark)}</span>
                    </div>
                  ))}
                </div>

                <div
                  className={styles.playhead}
                  style={{ left: `${playhead * zoom}px` }}
                >
                  <span className={styles.playheadCap} />
                </div>

                <div
                  className={styles.trackArea}
                  style={{ minHeight: `${lanes.count * 96}px` }}
                >
                  {orderedClips.length ? (
                    orderedClips.map((clip) => {
                      const laneIndex = lanes.map.get(clip.id) ?? 0;
                      const source =
                        clip.kind === "audio"
                          ? sources.find((candidate) => candidate.id === clip.sourceId) ?? null
                          : null;

                      return (
                        <div
                          className={`${styles.clip} ${
                            selectedClipId === clip.id ? styles.clipSelected : ""
                          }`}
                          key={clip.id}
                          style={{
                            left: `${clip.startTime * zoom}px`,
                            top: `${laneIndex * 96 + 12}px`,
                            width: `${Math.max(56, clip.duration * zoom)}px`,
                            ["--clip-color" as string]: clip.color,
                          }}
                        >
                          <button
                            className={styles.clipBody}
                            onPointerDown={(event) => handleClipPointerDown(event, clip)}
                            type="button"
                          >
                            <div className={styles.clipTopline}>
                              <strong>{clip.name}</strong>
                              <small>{formatTime(clip.duration)}</small>
                            </div>

                            <div className={styles.clipCanvas}>
                              {clip.kind === "audio" && source ? (
                                <WaveformPreview
                                  className={styles.waveformCanvas}
                                  clip={clip}
                                  source={source}
                                />
                              ) : (
                                <div className={styles.silencePreview}>
                                  <span />
                                  <span />
                                  <span />
                                </div>
                              )}
                            </div>

                            {clip.fadeIn > 0 && (
                              <span
                                className={styles.fadeOverlayStart}
                                style={{
                                  width: `${(clip.fadeIn / clip.duration) * 100}%`,
                                }}
                              />
                            )}

                            {clip.fadeOut > 0 && (
                              <span
                                className={styles.fadeOverlayEnd}
                                style={{
                                  width: `${(clip.fadeOut / clip.duration) * 100}%`,
                                }}
                              />
                            )}
                          </button>

                          <button
                            aria-label={`${clip.name} 시작 자르기`}
                            className={`${styles.trimHandle} ${styles.trimHandleStart}`}
                            onPointerDown={(event) =>
                              handleTrimPointerDown(event, clip, "start")
                            }
                            type="button"
                          />
                          <button
                            aria-label={`${clip.name} 끝 자르기`}
                            className={`${styles.trimHandle} ${styles.trimHandleEnd}`}
                            onPointerDown={(event) =>
                              handleTrimPointerDown(event, clip, "end")
                            }
                            type="button"
                          />
                        </div>
                      );
                    })
                  ) : (
                    <div className={styles.emptyTimeline}>
                      <strong>빈 타임라인</strong>
                      <p>
                        파일을 올리거나 무음 공간을 넣어 시작하세요. 이후 클립을
                        드래그로 옮기고, 양끝 손잡이로 트림하고, 플레이헤드 위치에서
                        바로 컷할 수 있습니다.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <footer className={styles.footerNote}>
            팁: 드래그로 클립 이동, 양끝 손잡이로 트림, S로 컷, Delete로 삭제,
            스냅 해제 시 더 미세하게 편집됩니다.
          </footer>
        </section>
      </section>
    </main>
  );
}
