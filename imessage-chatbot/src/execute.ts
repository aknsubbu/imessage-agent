// Carries out one action from the agent server against Spectrum.
import { attachment, markdown, type Message, poll, richlink, type Space, text, voice } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";
import type { Action, OutContent } from "../../protocol/index.ts";
import type { Result } from "./actions.ts";
import type { Recent } from "./recent.ts";

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    // Spectrum's sends have no timeout of their own.
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);

function build(content: OutContent) {
  switch (content.type) {
    case "text":
      return text(content.text);
    case "markdown":
      return markdown(content.markdown);
    case "attachment":
      return attachment(content.path, { name: content.name, mimeType: content.mimeType });
    case "voice":
      return voice(content.path, { mimeType: content.mimeType });
    case "richlink":
      return richlink(content.url);
    case "poll":
      return poll(content.title, ...content.options);
  }
}

export function createExecutor(opts: {
  resolveSpace: (chatId: string) => Promise<Space>;
  messages: Recent<Message>;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const find = async (space: Space, messageId: string): Promise<Message | undefined> =>
    opts.messages.get(messageId) ?? (await space.getMessage(messageId)) ?? undefined;

  async function run(action: Action): Promise<Result> {
    const space = await opts.resolveSpace(action.chatId);
    switch (action.type) {
      case "typing":
        await (action.state === "start" ? space.startTyping() : space.stopTyping());
        return { status: "sent" };

      case "read": {
        const target = await find(space, action.messageId);
        if (!target) return { status: "skipped" };
        await target.read();
        return { status: "sent" };
      }

      case "send": {
        let content = build(action.content);
        if (action.effect) {
          const effects: Record<string, Parameters<typeof effect>[1] | undefined> = imessage.effect.message;
          const chosen = effects[action.effect];
          if (chosen) content = effect(content, chosen);
        }
        const target = action.replyTo ? await find(space, action.replyTo) : undefined;
        // Spectrum resolves with nothing when the provider skipped the content as unsupported.
        const sent = target ? await target.reply(content) : await space.send(content);
        if (!sent) return { status: "skipped" };
        opts.messages.set(sent.id, sent);
        return { status: "sent", messageId: sent.id };
      }

      case "react": {
        const target = await find(space, action.messageId);
        if (!target) return { status: "skipped" };
        const reaction = await target.react(action.emoji);
        return reaction ? { status: "sent", messageId: reaction.id } : { status: "skipped" };
      }

      case "edit": {
        const target = await find(space, action.messageId);
        if (!target) return { status: "skipped" };
        await target.edit(action.text);
        return { status: "sent" };
      }

      case "unsend": {
        const target = await find(space, action.messageId);
        if (!target) return { status: "skipped" };
        await target.unsend();
        return { status: "sent" };
      }
    }
  }

  return async (action: Action): Promise<Result> => {
    try {
      return await withTimeout(run(action), timeoutMs, action.type);
    } catch (err) {
      const e = err as { message?: string; code?: unknown; retryable?: unknown };
      return {
        status: "failed",
        error: {
          message: String(e?.message ?? err).slice(0, 500),
          code: typeof e?.code === "string" ? e.code : undefined,
          retryable: typeof e?.retryable === "boolean" ? e.retryable : undefined,
        },
      };
    }
  };
}
