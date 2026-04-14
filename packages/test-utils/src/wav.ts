/// <reference types="node" />
import { readFileSync } from "node:fs";

export interface Wav {
  sampleRate: number;
  numChannels: number;
  samples: Float32Array[];
}

export function readWavF32(path: string): Wav {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error(`not RIFF: ${path}`);
  if (b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`not WAVE: ${path}`);

  let offset = 12;
  let fmt: {
    audioFormat: number;
    numChannels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let dataOffset = -1;
  let dataSize = -1;

  while (offset + 8 <= b.length) {
    const id = b.toString("ascii", offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: b.readUInt16LE(payload + 0),
        numChannels: b.readUInt16LE(payload + 2),
        sampleRate: b.readUInt32LE(payload + 4),
        bitsPerSample: b.readUInt16LE(payload + 14),
      };
    } else if (id === "data") {
      dataOffset = payload;
      dataSize = size;
      break;
    }
    offset = payload + size + (size & 1);
  }

  if (!fmt) throw new Error(`no fmt chunk: ${path}`);
  if (dataOffset < 0) throw new Error(`no data chunk: ${path}`);
  if (fmt.audioFormat !== 3) {
    throw new Error(`expected IEEE float (audioFormat=3), got ${fmt.audioFormat}: ${path}`);
  }
  if (fmt.bitsPerSample !== 32) {
    throw new Error(`expected 32-bit samples, got ${fmt.bitsPerSample}: ${path}`);
  }

  const numChannels = fmt.numChannels;
  const totalSamples = dataSize / 4;
  const samplesPerCh = totalSamples / numChannels;
  if (!Number.isInteger(samplesPerCh)) {
    throw new Error(`data length ${dataSize} not divisible by ${numChannels} channels × 4 bytes`);
  }

  const interleaved = new Float32Array(b.buffer, b.byteOffset + dataOffset, totalSamples);
  const samples: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    const ch = new Float32Array(samplesPerCh);
    for (let i = 0; i < samplesPerCh; i++) ch[i] = interleaved[i * numChannels + c]!;
    samples.push(ch);
  }

  return { sampleRate: fmt.sampleRate, numChannels, samples };
}
