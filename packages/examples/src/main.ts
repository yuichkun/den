import wasmUrl from "@denaudio/core/den_core.wasm?url";
import workletUrl from "@denaudio/worklet/processor.js?url";
import { createDenNode, registerDenWorklet } from "@denaudio/worklet";

/**
 * Playwright smoke hook (issue #3 §5.1). Sub C replaces the examples app.
 */
async function runSmoke(): Promise<boolean> {
  const ctx = new OfflineAudioContext(2, 128, 48000);
  await registerDenWorklet(ctx, { wasmUrl, workletUrl });
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 440;
  const node = await createDenNode(
    ctx,
    "passthrough",
    {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    },
    { wasmUrl, workletUrl },
  );
  osc.connect(node);
  node.connect(ctx.destination);
  osc.start(0);
  const buf = await ctx.startRendering();
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i]) || Number.isNaN(data[i])) return false;
    }
  }
  return true;
}

declare global {
  interface Window {
    __denRunSmoke?: () => Promise<boolean>;
  }
}

window.__denRunSmoke = runSmoke;
