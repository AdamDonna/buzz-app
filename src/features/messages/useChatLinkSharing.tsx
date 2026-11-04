import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import { chatShareDestination, shareSoloChatAccess } from "../solo/share";
import { ownSolo, SOLO_ACCESS_DISCLOSURE } from "../solo/labels";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

type Pending = {
  sources: readonly [ChannelDetails, ...ChannelDetails[]];
  signal: AbortSignal;
  check(): void;
  finish(send: boolean): void;
  attempts: Map<string, ChannelDetailsDraft>;
  destination: string;
  busy: boolean;
  error?: string;
  checkRequired?: boolean;
};

/** Confirm community reading; the composer owns sending its original message once. */
export function useChatLinkSharing(
  session: RelaySession | undefined,
  channelId: string,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const running = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  async function share() {
    if (!session || !pending || running.current) return;
    const request = pending;
    running.current = true;
    setPending({ ...request, busy: true });
    try {
      for (const base of request.sources) {
        await shareSoloChatAccess(session, base.channelId, {
          signal: request.signal,
          confirmed: base,
          attempts: request.attempts,
          check: request.check,
        });
      }
      request.check();
      request.finish(true);
    } catch (reason) {
      if (!request.signal.aborted)
        setPending({
          ...request,
          busy: false,
          error: reason instanceof Error ? reason.message : String(reason),
          checkRequired: request.sources.some(({ channelId: id }) => {
            const attempt = session.channelDetails.snapshot(id);
            return (
              attempt?.status === "unconfirmed" &&
              attempt.draft === request.attempts.get(id)
            );
          }),
        });
    } finally {
      running.current = false;
    }
  }
  return {
    async prepare(
      sources: readonly string[],
      signal: AbortSignal,
      current: () => boolean,
    ): Promise<boolean> {
      signal.throwIfAborted();
      if (!session) return true;
      const list = session.channels.list().channels;
      const destination = list.find((channel) => channel.id === channelId);
      if (!chatShareDestination(destination)) return true;
      const check = () => {
        signal.throwIfAborted();
        if (!current())
          throw new Error(
            "The draft changed. Close this dialog and send again.",
          );
      };
      const attempts = new Map<string, ChannelDetailsDraft>();
      const privateChats: ChannelDetails[] = [];
      for (const id of new Set(sources)) {
        if (
          !ownSolo(
            list.find((channel) => channel.id === id),
            session.viewer,
          )
        )
          continue;
        const base = await shareSoloChatAccess(session, id, {
          signal,
          attempts,
          check,
        });
        if (base) privateChats.push(base);
      }
      check();
      const [first, ...rest] = privateChats;
      if (!first) return true;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (send: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(send);
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        setPending({
          sources: [first, ...rest],
          signal,
          check,
          finish,
          attempts,
          destination:
            destination?.channelType === "dm"
              ? "this DM"
              : `#${destination?.name ?? "channel"}`,
          busy: false,
        });
      });
    },
    dialog: pending && (
      <AlertDialog
        title="Change general access?"
        description={`This will change ${pending.sources.length > 1 ? "these chats" : "the chat"} from Private to View only and send your message and chat ${pending.sources.length > 1 ? "links" : "link"} to ${pending.destination}. ${SOLO_ACCESS_DISCLOSURE}${pending.sources.length > 1 ? ` This applies to: ${pending.sources.map((base) => base.name).join(", ")}.` : ""}`}
        onClose={() => pending.finish(false)}
        pending={pending.busy}
        initialFocus={cancel}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          <>
            <Button
              ref={cancel}
              disabled={pending.busy}
              onClick={() => pending.finish(false)}
            >
              Cancel
            </Button>
            <Button
              variant="prominent"
              loading={pending.busy}
              onClick={() => void share()}
            >
              {pending.checkRequired
                ? "Check access and send"
                : pending.error
                  ? "Retry share and send"
                  : "Share"}
            </Button>
          </>
        }
      >
        {pending.error && (
          <p role="alert">
            {pending.error} Your message has not been sent. Any access change
            already saved is kept.
          </p>
        )}
      </AlertDialog>
    ),
  };
}
