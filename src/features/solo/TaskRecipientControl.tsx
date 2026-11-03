import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import type { ComposerSession } from "../messages/composer-session";
import { taskChannelContext, type TaskContext } from "./task-mode";

/** The message override is transient; only this explicit action changes primary. */
export function TaskRecipientControl({
  session,
  channelId,
  context,
  explicit,
  disabled,
  onUpdated,
}: {
  session: ComposerSession;
  channelId: string;
  context: TaskContext;
  explicit: readonly string[];
  disabled: boolean;
  onUpdated(): void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const policy = context.mode.participants;
  const primary = policy.defaultRecipient(channelId);
  const name = (key: string) =>
    session.profiles.snapshot().get(key)?.name ||
    session.agentChoices
      .snapshot()
      .identities.find((item) => item.pubkey === key)?.name ||
    key.slice(0, 12);
  const members =
    session.channels.list().channels.find((item) => item.id === channelId)
      ?.members ?? [];
  const eligible = members.filter(
    (key) => key !== session.viewer && policy.eligible(key),
  );
  const target = explicit.length === 1 ? explicit[0] : primary;
  const label = explicit.length
    ? `This message → ${explicit.map(name).join(", ")}`
    : target && eligible.includes(target)
      ? `To ${name(target)}`
      : "Choose primary";
  async function makePrimary(key: string) {
    setBusy(true);
    setError(undefined);
    try {
      const current = taskChannelContext(session, channelId);
      if (
        !current ||
        current.binding.incarnation !== context.binding.incarnation ||
        !current.mode.participants.eligible(key) ||
        !members.includes(key)
      )
        throw new Error("This task participant changed. Review and retry.");
      await current.mode.participants.makePrimary(channelId, key);
      onUpdated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button size="sm" variant="ghost" disabled={disabled || busy}>
              {label}
            </Button>
          }
        >
          {label}
        </MenuTrigger>
        <MenuPopup aria-label="Task primary agent" side="top" align="start">
          {eligible.map((key) => (
            <MenuItem
              key={key}
              disabled={key === primary}
              onClick={() => {
                void makePrimary(key);
              }}
            >
              {key === primary
                ? `${name(key)} (primary)`
                : `Make ${name(key)} primary`}
            </MenuItem>
          ))}
        </MenuPopup>
      </MenuRoot>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
