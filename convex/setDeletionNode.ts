"use node";

import { v } from "convex/values";

import { createModalClientFromEnv } from "./setIngestModal";
import { internalAction } from "./_generated/server";

export const cancelModalCalls = internalAction({
  args: { modalFunctionCallIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const modal = createModalClientFromEnv();

    for (const functionCallId of args.modalFunctionCallIds) {
      const functionCall = await modal.functionCalls.fromId(functionCallId);
      await functionCall.cancel({ terminateContainers: true });
    }

    return null;
  },
});
