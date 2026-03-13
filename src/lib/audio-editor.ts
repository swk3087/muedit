export const MIN_CLIP_DURATION = 0.08;

export type AudioSource = {
  id: string;
  name: string;
  duration: number;
  buffer: AudioBuffer;
  peaks: Float32Array;
  color: string;
};

export type Clip = {
  id: string;
  kind: "audio" | "silence";
  sourceId: string | null;
  name: string;
  startTime: number;
  duration: number;
  sourceStart: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  color: string;
};

type LaneInfo = {
  map: Map<string, number>;
  count: number;
};

const CLIP_PALETTE = [
  "#d4673c",
  "#457ee8",
  "#2d9a76",
  "#cc8a1d",
  "#9657d7",
  "#d95d86",
];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function stripExtension(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function hashSeed(seed: string) {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

export function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 11)}`;
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(safe % 60)
    .toString()
    .padStart(2, "0");
  const hundredths = Math.floor((safe % 1) * 100)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${secs}.${hundredths}`;
}

export function getSnapStep(zoom: number) {
  if (zoom >= 220) {
    return 0.05;
  }

  if (zoom >= 130) {
    return 0.1;
  }

  return 0.25;
}

export function snapTime(value: number, zoom: number, enabled: boolean) {
  if (!enabled) {
    return Math.max(0, value);
  }

  const step = getSnapStep(zoom);
  return Math.max(0, Math.round(value / step) * step);
}

export function getProjectDuration(clips: Clip[]) {
  return clips.reduce(
    (maxDuration, clip) => Math.max(maxDuration, clip.startTime + clip.duration),
    0,
  );
}

export function createAudioSource(name: string, buffer: AudioBuffer): AudioSource {
  const seed = hashSeed(name);
  const color = CLIP_PALETTE[seed % CLIP_PALETTE.length];

  return {
    id: createId("src"),
    name: stripExtension(name),
    duration: buffer.duration,
    buffer,
    peaks: computePeaks(buffer),
    color,
  };
}

export function createClipFromSource(source: AudioSource, startTime: number): Clip {
  return {
    id: createId("clip"),
    kind: "audio",
    sourceId: source.id,
    name: source.name,
    startTime,
    duration: source.duration,
    sourceStart: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    color: source.color,
  };
}

export function createSilenceClip(startTime: number, duration: number): Clip {
  return {
    id: createId("silence"),
    kind: "silence",
    sourceId: null,
    name: "Silent space",
    startTime,
    duration: Math.max(duration, 0.25),
    sourceStart: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    color: "#556070",
  };
}

export function normalizeClip(clip: Clip, source: AudioSource | null): Clip {
  let duration = Math.max(MIN_CLIP_DURATION, clip.duration);
  let sourceStart = clip.kind === "audio" ? Math.max(0, clip.sourceStart) : 0;

  if (clip.kind === "audio" && source) {
    const maxSourceStart = Math.max(0, source.duration - MIN_CLIP_DURATION);
    sourceStart = clamp(sourceStart, 0, maxSourceStart);
    duration = clamp(
      duration,
      MIN_CLIP_DURATION,
      Math.max(MIN_CLIP_DURATION, source.duration - sourceStart),
    );
  }

  let fadeIn = clamp(clip.fadeIn, 0, duration);
  let fadeOut = clamp(clip.fadeOut, 0, duration);

  if (fadeIn + fadeOut > duration) {
    const scale = duration / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }

  return {
    ...clip,
    name: clip.name.trim() || (clip.kind === "audio" ? "Audio clip" : "Silent space"),
    startTime: Math.max(0, clip.startTime),
    duration,
    sourceStart,
    gain: clamp(clip.gain, 0, 2.5),
    fadeIn,
    fadeOut,
  };
}

export function splitClip(clip: Clip, splitTime: number, source: AudioSource | null) {
  if (splitTime <= clip.startTime + MIN_CLIP_DURATION) {
    return null;
  }

  if (splitTime >= clip.startTime + clip.duration - MIN_CLIP_DURATION) {
    return null;
  }

  const leftDuration = splitTime - clip.startTime;
  const rightDuration = clip.duration - leftDuration;

  const leftClip = normalizeClip(
    {
      ...clip,
      id: createId("clip"),
      duration: leftDuration,
      fadeIn: 0,
      fadeOut: 0,
    },
    source,
  );

  const rightClip = normalizeClip(
    {
      ...clip,
      id: createId("clip"),
      startTime: splitTime,
      duration: rightDuration,
      sourceStart: clip.sourceStart + leftDuration,
      fadeIn: 0,
      fadeOut: 0,
    },
    source,
  );

  return [leftClip, rightClip] as const;
}

export function duplicateClip(clip: Clip, source: AudioSource | null): Clip {
  return normalizeClip(
    {
      ...clip,
      id: createId("clip"),
      startTime: clip.startTime + clip.duration + 0.2,
      name: `${clip.name} copy`,
    },
    source,
  );
}

export function assignClipLanes(clips: Clip[]): LaneInfo {
  const laneEnds: number[] = [];
  const map = new Map<string, number>();
  const ordered = [...clips].sort(
    (left, right) => left.startTime - right.startTime || left.duration - right.duration,
  );

  for (const clip of ordered) {
    let laneIndex = laneEnds.findIndex((laneEnd) => clip.startTime >= laneEnd - 0.001);

    if (laneIndex === -1) {
      laneIndex = laneEnds.length;
      laneEnds.push(clip.startTime + clip.duration);
    } else {
      laneEnds[laneIndex] = clip.startTime + clip.duration;
    }

    map.set(clip.id, laneIndex);
  }

  return {
    map,
    count: Math.max(1, laneEnds.length),
  };
}

function getClipLevel(clip: Clip, localTime: number) {
  const time = clamp(localTime, 0, clip.duration);

  if (clip.fadeIn > 0 && time < clip.fadeIn) {
    return time / clip.fadeIn;
  }

  if (clip.fadeOut > 0 && time > clip.duration - clip.fadeOut) {
    return (clip.duration - time) / clip.fadeOut;
  }

  return 1;
}

export function scheduleClipEnvelope(
  gainParam: AudioParam,
  clip: Clip,
  startAt: number,
  startOffset = 0,
) {
  const baseGain = clip.gain;
  const clipEnd = clip.duration;
  const localOffset = clamp(startOffset, 0, clipEnd);
  const fadeOutStart = clip.duration - clip.fadeOut;
  const initialLevel = getClipLevel(clip, localOffset) * baseGain;

  gainParam.cancelScheduledValues(startAt);
  gainParam.setValueAtTime(initialLevel, startAt);

  if (clip.fadeIn > 0 && localOffset < clip.fadeIn) {
    gainParam.linearRampToValueAtTime(baseGain, startAt + (clip.fadeIn - localOffset));
  }

  if (clip.fadeOut > 0) {
    if (localOffset < fadeOutStart) {
      gainParam.setValueAtTime(baseGain, startAt + (fadeOutStart - localOffset));
      gainParam.linearRampToValueAtTime(0, startAt + (clipEnd - localOffset));
    } else {
      gainParam.linearRampToValueAtTime(0, startAt + (clipEnd - localOffset));
    }
  }
}

export function computePeaks(buffer: AudioBuffer, resolution = 1400) {
  const length = buffer.length;
  const channels = Math.min(buffer.numberOfChannels, 2);
  const blockSize = Math.max(1, Math.floor(length / resolution));
  const peaks = new Float32Array(Math.ceil(length / blockSize));

  for (let blockIndex = 0; blockIndex < peaks.length; blockIndex += 1) {
    const start = blockIndex * blockSize;
    const end = Math.min(start + blockSize, length);
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let combined = 0;

      for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
        combined += Math.abs(buffer.getChannelData(channelIndex)[sampleIndex]);
      }

      peak = Math.max(peak, combined / channels);
    }

    peaks[blockIndex] = peak;
  }

  return peaks;
}

export function getRulerStep(zoom: number) {
  if (zoom >= 260) {
    return 0.25;
  }

  if (zoom >= 160) {
    return 0.5;
  }

  if (zoom >= 90) {
    return 1;
  }

  if (zoom >= 50) {
    return 2;
  }

  return 4;
}

function writeWavString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function audioBufferToWav(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels;
  const bytesPerSample = 4;
  const blockAlign = channels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeWavString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeWavString(view, 8, "WAVE");
  writeWavString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeWavString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = Array.from(
    { length: channels },
    (_, index) => buffer.getChannelData(index),
  );
  let offset = 44;

  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      view.setFloat32(offset, channelData[channelIndex][sampleIndex], true);
      offset += bytesPerSample;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}
