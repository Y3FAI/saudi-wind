import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatSaudiDate } from "../lib/format";
import { frameLabel } from "../lib/wind";
import type { WindFrame } from "../types/wind";
import "./windTimeline.css";

const PLAY_INTERVAL_MS = 500;

const LEVEL_OPTIONS = [
  { value: 10, label: "١٠ م" },
  { value: 100, label: "١٠٠ م" },
] as const;

export interface WindTimelineProps {
  frames: WindFrame[];
  frameIndex: number;
  onFrameIndexChange: (index: number) => void;
  level: number;
  availableLevels: number[];
  onLevelChange: (level: number) => void;
  gusts: boolean;
  gustsAvailable: boolean;
  onGustsChange: (gusts: boolean) => void;
  now: number;
}

export function WindTimeline({
  frames,
  frameIndex,
  onFrameIndexChange,
  level,
  availableLevels,
  onLevelChange,
  gusts,
  gustsAvailable,
  onGustsChange,
  now,
}: WindTimelineProps) {
  const [playing, setPlaying] = useState(false);
  const indexRef = useRef(frameIndex);
  const lastIndex = Math.max(frames.length - 1, 0);
  indexRef.current = frameIndex;

  const labels = useMemo(
    () => frames.map((frame) => frameLabel(frame, now)),
    [frames, now],
  );
  const currentLabel = labels[frameIndex] ?? "الآن";
  const currentFrame = frames[frameIndex];

  useEffect(() => {
    if (frames.length < 2) setPlaying(false);
  }, [frames.length]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const next = indexRef.current + 1;
      if (next >= lastIndex) {
        indexRef.current = lastIndex;
        onFrameIndexChange(lastIndex);
        setPlaying(false);
        return;
      }
      indexRef.current = next;
      onFrameIndexChange(next);
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, lastIndex, onFrameIndexChange]);

  const togglePlaying = useCallback(() => {
    setPlaying((current) => {
      if (current) return false;
      if (indexRef.current >= lastIndex) {
        indexRef.current = 0;
        onFrameIndexChange(0);
      }
      return true;
    });
  }, [lastIndex, onFrameIndexChange]);

  return (
    <div
      className="wind-timeline"
      role="group"
      aria-label="شريط زمني لإطارات الرياح"
      data-playing={playing ? "true" : "false"}
      data-frame-step={currentFrame?.step ?? 0}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="wind-timeline__readout">
        <span className="wind-timeline__label" aria-live="polite">
          {currentLabel}
        </span>
        {currentFrame && (
          <span className="wind-timeline__clock" aria-hidden="true">
            {formatSaudiDate(currentFrame.validTime)}
          </span>
        )}
      </div>

      <div className="wind-timeline__track">
        <input
          className="wind-timeline__range"
          type="range"
          dir="ltr"
          min={0}
          max={lastIndex}
          step={1}
          value={frameIndex}
          disabled={frames.length < 2}
          aria-label="اختيار وقت التوقّع"
          aria-valuenow={frameIndex}
          aria-valuetext={
            currentFrame
              ? `${currentLabel} · ${formatSaudiDate(currentFrame.validTime)}`
              : currentLabel
          }
          onChange={(event) => onFrameIndexChange(Number(event.target.value))}
        />
        <div className="wind-timeline__scale" aria-hidden="true">
          <span>{labels[0] ?? "الآن"}</span>
          <span>{labels[lastIndex] ?? ""}</span>
        </div>
      </div>

      <div className="wind-timeline__actions">
        <button
          type="button"
          className="wind-timeline__play"
          onClick={togglePlaying}
          disabled={frames.length < 2}
          aria-label={playing ? "إيقاف العرض الزمني" : "تشغيل العرض الزمني"}
        >
          {playing ? "إيقاف" : "تشغيل"}
        </button>

        <fieldset className="wind-timeline__levels" aria-label="ارتفاع الرياح">
          <legend>ارتفاع الرياح</legend>
          {LEVEL_OPTIONS.map((option) => {
            const available = availableLevels.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={level === option.value}
                aria-label={`ارتفاع ${option.value} متر`}
                data-level={option.value}
                disabled={!available}
                onClick={() => onLevelChange(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </fieldset>

        <button
          type="button"
          className="wind-timeline__gusts"
          aria-pressed={gusts}
          aria-label="هبّات الرياح عند عشرة أمتار"
          disabled={!gustsAvailable}
          onClick={() => onGustsChange(!gusts)}
        >
          هبّات
        </button>
      </div>
    </div>
  );
}
