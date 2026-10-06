// Preserve native bounds. Unbounded f32 defaults and ranges too large for safe
// numeric interaction remain exact-input-only; never invent a narrower range.
export function sliderBounds(min: number, max: number): { min: number; max: number } | null {
  const span = max - min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(span) || span <= 0) return null;
  if (Math.abs(min) > Number.MAX_SAFE_INTEGER || Math.abs(max) > Number.MAX_SAFE_INTEGER || span > Number.MAX_SAFE_INTEGER) return null;
  return { min, max };
}

// AudioParam.value can still expose the previous render-quantum value after
// scheduling. Return the exact f32 value sent to the native timeline for UI sync.
export function scheduleParameter(parameter: Pick<AudioParam, 'minValue' | 'maxValue' | 'setValueAtTime'>, value: number, time: number): number {
  const scheduled = Math.fround(Math.max(parameter.minValue, Math.min(parameter.maxValue, value)));
  parameter.setValueAtTime(scheduled, time);
  return scheduled;
}
