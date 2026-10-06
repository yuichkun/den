// Preserve native bounds. Unbounded f32 defaults and ranges too large for safe
// numeric interaction remain exact-input-only; never invent a narrower range.
export function sliderBounds(min: number, max: number): { min: number; max: number } | null {
  const span = max - min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(span) || span <= 0) return null;
  if (Math.abs(min) > Number.MAX_SAFE_INTEGER || Math.abs(max) > Number.MAX_SAFE_INTEGER || span > Number.MAX_SAFE_INTEGER) return null;
  return { min, max };
}
