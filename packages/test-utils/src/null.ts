export function rmsDiffDbFs(a: Float32Array[], b: Float32Array[]): number {
  if (a.length !== b.length) {
    throw new Error(`channel count mismatch: ${a.length} vs ${b.length}`);
  }
  let sumSq = 0;
  let n = 0;
  for (let c = 0; c < a.length; c++) {
    const ac = a[c]!;
    const bc = b[c]!;
    if (ac.length !== bc.length) {
      throw new Error(`length mismatch on ch ${c}: ${ac.length} vs ${bc.length}`);
    }
    for (let i = 0; i < ac.length; i++) {
      const d = (ac[i] as number) - (bc[i] as number);
      sumSq += d * d;
      n++;
    }
  }
  if (n === 0) return -Infinity;
  const rms = Math.sqrt(sumSq / n);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

export function assertNullBelow(
  actual: Float32Array[],
  golden: Float32Array[],
  dbFloor: number,
  label: string,
): void {
  const db = rmsDiffDbFs(actual, golden);
  if (db > dbFloor) {
    throw new Error(
      `null test FAILED for ${label}: diff RMS = ${db.toFixed(2)} dBFS (must be <= ${dbFloor.toFixed(2)})`,
    );
  }
}
