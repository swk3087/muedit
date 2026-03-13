"use client";

import { useEffect, useRef } from "react";
import type { AudioSource, Clip } from "@/lib/audio-editor";

export function WaveformPreview({
  clip,
  source,
  className,
}: {
  clip: Clip;
  source: AudioSource;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const redraw = () => {
      const context = canvas.getContext("2d");
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (!context || width === 0 || height === 0) {
        return;
      }

      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "rgba(255, 255, 255, 0.08)";
      context.fillRect(0, height / 2, width, 1);

      const peaks = source.peaks;
      const startRatio = clip.sourceStart / source.duration;
      const endRatio = (clip.sourceStart + clip.duration) / source.duration;
      const peakStart = Math.floor(startRatio * peaks.length);
      const peakEnd = Math.max(peakStart + 1, Math.ceil(endRatio * peaks.length));
      const visiblePeaks = peaks.slice(peakStart, peakEnd);
      const step = visiblePeaks.length / Math.max(width, 1);

      context.fillStyle = "rgba(255, 248, 238, 0.82)";

      for (let x = 0; x < width; x += 1) {
        const sampleIndex = Math.min(
          visiblePeaks.length - 1,
          Math.floor(x * step),
        );
        const amplitude = visiblePeaks[sampleIndex] || 0;
        const barHeight = Math.max(1, amplitude * (height - 6));
        const top = (height - barHeight) / 2;
        context.fillRect(x, top, 1, barHeight);
      }
    };

    redraw();

    const observer = new ResizeObserver(() => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
      }

      frameRef.current = window.requestAnimationFrame(redraw);
    });

    observer.observe(canvas);

    return () => {
      observer.disconnect();

      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [clip.duration, clip.sourceStart, source.duration, source.peaks]);

  return <canvas className={className} ref={canvasRef} />;
}
