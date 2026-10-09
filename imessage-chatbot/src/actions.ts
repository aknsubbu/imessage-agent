// Takes actions from the agent server and makes sure each one is carried out
// at most once. Free of Spectrum imports so the rules can be tested directly.
import type { Ack, Action } from "../../protocol/index.ts";
import { Recent } from "./recent.ts";

export type Result = Omit<Ack, "actionId" | "status"> & { status: "sent" | "skipped" | "failed" };

export function createActionRunner(deps: {
  ack: (ack: Ack, attempts?: number) => Promise<boolean>;
  execute: (action: Action) => Promise<Result>;
  log: (message: string) => void;
}) {
  const claimed = new Recent<true>(5000);

  return {
    /**
     * The server offers an action again when it thinks it was lost. Returns
     * false if this process already has it in hand.
     */
    claim(action: Action): boolean {
      if (claimed.get(action.id)) return false;
      claimed.set(action.id, true);
      return true;
    },

    async carryOut(action: Action): Promise<void> {
      // Sends and tapbacks must never happen twice. Telling the server "sending"
      // first means it will not offer the action again if this process dies now.
      const visible = action.type !== "typing" && action.type !== "read";
      if (visible && !(await deps.ack({ actionId: action.id, status: "sending" }, 3))) {
        // Nothing was sent. Release the claim so the server's next offer is accepted.
        claimed.delete(action.id);
        return;
      }
      const result = await deps.execute(action);
      if (visible || result.status === "failed") {
        deps.log(`out ${action.type} ${result.status}${result.error ? ` (${result.error.code ?? result.error.message})` : ""}`);
      }
      await deps.ack({ actionId: action.id, ...result }, 4);
    },
  };
}
