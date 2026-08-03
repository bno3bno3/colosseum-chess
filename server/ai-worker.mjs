import { parentPort } from "node:worker_threads";
import { chooseAIAction } from "./ai-engine.mjs";

parentPort.on("message", (message) => {
  if (message?.type !== "search") return;
  try {
    const result = chooseAIAction(message.publicState, message.color, message.options);
    parentPort.postMessage({ taskId: message.taskId, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      taskId: message.taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
