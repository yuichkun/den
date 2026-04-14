import { createDenNode, type RegisterOptions } from "@denaudio/worklet";

export class Passthrough extends AudioWorkletNode {
  static async register(ctx: BaseAudioContext, options?: RegisterOptions): Promise<void> {
    // Eagerly establish the module + wasm cache; create a one-shot node and drop.
    const node = await createDenNode(
      ctx,
      "passthrough",
      { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] },
      options,
    );
    node.disconnect();
  }

  private constructor(ctx: BaseAudioContext, node: AudioWorkletNode) {
    // Not used; see factory.
    super(ctx, "den-processor", {});
    void node;
  }

  static async create(ctx: BaseAudioContext, options?: RegisterOptions): Promise<AudioWorkletNode> {
    return createDenNode(
      ctx,
      "passthrough",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      },
      options,
    );
  }
}
