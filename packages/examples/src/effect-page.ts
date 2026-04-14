import type { RegisterOptions } from "@denaudio/worklet";

import {
  type ABPlayerHandle,
  mountABPlayer,
  mountFilePicker,
  mountParamSlider,
  mountSpectrogram,
  mountWaveform,
  USER_FILE_OPTION,
} from "./widgets.js";

/** Spec for a single AudioParam slider. Mirrors `AudioParam` semantics. */
export interface ParamSpec {
  /** Must match the `name` of the actual `AudioParam` on the node. */
  name: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  /** Optional human label (defaults to `name`). */
  label?: string;
}

export interface EffectPageOptions<TNode extends AudioNode> {
  title: string;
  description: string;
  /** The effect class's `static async register(ctx, opts)` method. */
  register: (ctx: BaseAudioContext, opts: RegisterOptions) => Promise<void>;
  /**
   * Sync constructor for the effect node — must be callable any number
   * of times after `register` resolves. `currentParams` is the live
   * dictionary of slider values; the constructor can inline-read it
   * (e.g. `new Gain(ctx, { gain: currentParams.gain })`) so each fresh
   * node starts where the user last set the slider.
   */
  makeNode: (ctx: AudioContext, currentParams: Record<string, number>) => TNode;
  /**
   * Called when the user moves a slider after a node has been built.
   * Effects map the param-by-name to the right `AudioParam` on `node`.
   * Receives `ctx` so the call can use `ctx.currentTime`.
   */
  applyParam?: (node: TNode, name: string, value: number, ctx: AudioContext) => void;
  /** Continuous params surfaced as sliders. */
  params?: ParamSpec[];
  /**
   * Wire `window.__denTier3a` so the Playwright spec (Tier3a) finds the
   * effect class + signal factories. Receives the resolved
   * `workletUrl` so the spec can reuse it.
   */
  bridge: (extras: { workletUrl: string }) => void;
  /** Worklet URL, normally imported via `?url` from the page. */
  workletUrl: string;
}

/**
 * Mount a complete effect catalog page (probe → A/B player + sliders +
 * file picker + waveform + spectrogram, with auto-refresh on every
 * change). Each `pages/<effect>.ts` is a thin declaration that delegates
 * to this helper; Sub E's add-effect template specifies the `EffectPageOptions`
 * shape rather than a 70-line page boilerplate.
 */
export async function mountEffectPage<TNode extends AudioNode>(
  root: HTMLElement,
  opts: EffectPageOptions<TNode>,
): Promise<void> {
  root.innerHTML = `
    <h2>${opts.title}</h2>
    <p>${opts.description}</p>
    <section id="status">loading…</section>
    <section id="ab"></section>
    <section id="params"></section>
    <p style="opacity:0.6;font-size:0.85em;margin:0.5rem 0;">
      The Wet/Dry slider in the A/B player only affects realtime playback.
      The visualizers below always show the effect output (wet); they
      auto-refresh when you change the signal selector OR move a parameter
      slider.
    </p>
    <section id="wave"></section>
    <section id="spec"></section>
  `;

  const status = root.querySelector<HTMLElement>("#status")!;

  // Probe pipeline on an OfflineAudioContext (no user gesture needed,
  // so the catalog can validate the build in headless Chromium).
  try {
    const probeCtx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: 128,
      sampleRate: 48000,
    });
    await opts.register(probeCtx, { workletUrl: opts.workletUrl });
    status.textContent = "pipeline ready ✓";
  } catch (err) {
    status.textContent = "pipeline failed — see console";
    throw err;
  }

  // Realtime AudioContext requires a user gesture; defer construction
  // until the user clicks "Enable A/B player". The catalog page therefore
  // loads cleanly without audio permissions and the Tier3a spec doesn't
  // race against an unwanted `AudioContext`.
  const abContainer = root.querySelector<HTMLElement>("#ab")!;
  abContainer.innerHTML = `<button class="enable">Enable A/B player</button>`;
  const enableBtn = abContainer.querySelector<HTMLButtonElement>(".enable")!;
  enableBtn.addEventListener("click", () => {
    void enableLive();
  });

  async function enableLive(): Promise<void> {
    enableBtn.disabled = true;
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await opts.register(ctx, { workletUrl: opts.workletUrl });
    } catch (err) {
      // Restore the button so the user can retry (typo in URL,
      // transient network failure, CSP rejection). Without this guard
      // the page is permanently broken with the only affordance
      // greyed out.
      console.error("[den] enableLive failed:", err);
      enableBtn.disabled = false;
      enableBtn.textContent = "Enable A/B player (retry)";
      try {
        await ctx.close();
      } catch {
        /* close() throws if already closed; ignore */
      }
      throw err;
    }
    abContainer.innerHTML = "";

    // Live param dictionary — each slider mutates this map and the
    // next `makeNode` reads it for the constructor's initial values.
    const params: Record<string, number> = {};
    for (const p of opts.params ?? []) params[p.name] = p.initial;

    let currentNode: TNode | null = null;
    let player: ABPlayerHandle | null = null;
    let refreshViz = async (): Promise<void> => {};

    player = mountABPlayer(
      abContainer,
      ctx,
      async (c) => {
        // `c` may be the realtime ctx (for play()) OR a fresh
        // OfflineAudioContext that `getLastRendered()` just minted.
        // Either way, the kernel needs the WASM bytes cached on it
        // before the sync constructor reads them via `getCachedWasmBytes`.
        // `register` is idempotent on the realtime ctx (cache hit) and
        // does the real fetch + addModule on each fresh offline ctx.
        await opts.register(c, { workletUrl: opts.workletUrl });
        currentNode = opts.makeNode(c, params);
        return currentNode;
      },
      () => refreshViz(),
      () => filePicker.current(),
    );

    // Visually integrate the file picker INSIDE the A/B player section so
    // the relationship to the "user file" entry in the signal dropdown is
    // obvious — earlier flat layout had the picker as a peer section
    // which read as unrelated UI. Append after `mountABPlayer` so the
    // player's `innerHTML` write doesn't clobber the picker container.
    const fileContainer = document.createElement("div");
    fileContainer.style.cssText =
      "margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #333;";
    abContainer.appendChild(fileContainer);
    const filePicker = mountFilePicker(fileContainer, ctx);

    filePicker.onChange((_buf, label) => {
      player?.refreshUserFile(label);
      // Auto-select the freshly loaded file so the user doesn't have
      // to manually open the dropdown to discover the connection.
      if (label) player?.setSignal(USER_FILE_OPTION);
      void refreshViz();
    });

    const paramsContainer = root.querySelector<HTMLElement>("#params")!;
    paramsContainer.innerHTML = "";
    for (const p of opts.params ?? []) {
      mountParamSlider(paramsContainer, p.name, {
        min: p.min,
        max: p.max,
        step: p.step,
        initial: p.initial,
        ...(p.label !== undefined ? { label: p.label } : {}),
        onChange: (v) => {
          params[p.name] = v;
          if (currentNode && opts.applyParam) {
            opts.applyParam(currentNode, p.name, v, ctx);
          }
          void refreshViz();
        },
      });
    }

    refreshViz = async () => {
      if (!player) return;
      try {
        const buf = await player.getLastRendered();
        mountWaveform(root.querySelector<HTMLElement>("#wave")!, buf);
        mountSpectrogram(root.querySelector<HTMLElement>("#spec")!, buf);
      } catch (err) {
        // E.g. user picks "user file" then clears it before refresh.
        console.warn("refreshViz skipped:", (err as Error).message);
      }
    };
    await refreshViz();
  }

  opts.bridge({ workletUrl: opts.workletUrl });
}
