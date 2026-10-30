import { useState } from "react";
import { canAddMembers } from "../../features/channel-members/members";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { compareRecent } from "../channels/sidebar-sections";

/** The private channels `viewer` is in, most recent first: those `bestie` is
 * in too, and the rest. DMs, Solo chats, huddle rooms and system channels
 * are not ones to add an agent to. */
export function privateChannels(
  channels: readonly ChannelSummary[],
  viewer: string,
  bestie: string,
) {
  const yours = channels
    .filter(
      (channel) =>
        !channel.archived &&
        !channel.huddle &&
        (channel.channelType === "stream" || channel.channelType === "forum") &&
        channel.private &&
        channel.members?.includes(viewer),
    )
    .sort(compareRecent);
  return {
    joined: yours.filter((channel) => channel.members?.includes(bestie)),
    others: yours.filter((channel) => !channel.members?.includes(bestie)),
  };
}

/** Removes `pubkey` from one channel as the Members dialog does, resolving
 * only once a fresh roster read confirms it. */
async function removeMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
) {
  const admin = session.memberAdministration;
  await admin.refresh(channelId);
  const read = admin.snapshot(channelId);
  if (read.status !== "ready")
    throw new Error(read.error ?? "Member roles are unavailable. Try again.");
  const expectedRole = read.authority.roles[pubkey];
  // Already gone: nothing to send.
  if (!expectedRole) return;
  await admin.run(channelId, { pubkey, expectedRole, role: "remove" });
  const { operation, error } = admin.snapshot(channelId);
  if (operation?.change.pubkey !== pubkey || operation.status !== "confirmed")
    throw new Error(error ?? "The removal isn't confirmed. Try again.");
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The private channels Bestie reads because it is a member. */
export function PrivateChannels({
  session,
  bestie,
}: {
  session: RelaySession;
  bestie: string;
}) {
  const list = useChannelList(session.channels);
  const { joined, others } = privateChannels(
    list.channels,
    session.viewer ?? "",
    bestie,
  );
  const addable = others.filter((channel) => canAddMembers(session, channel));
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /** Why each channel's last change failed, and whether it was to join. */
  const [failed, setFailed] = useState<
    Readonly<
      Record<string, Readonly<{ name: string; error: string; join: boolean }>>
    >
  >({});
  /** The channels Add to all asked about. */
  const [confirming, setConfirming] = useState<readonly ChannelSummary[]>();

  /** Runs `change` on each channel in turn, as adding several agents does,
   * and keeps why each one failed. */
  const run = async (
    channels: readonly ChannelSummary[],
    join: boolean,
    change: (id: string) => Promise<void>,
  ) => {
    const ids = new Set(channels.map((channel) => channel.id));
    setBusy((current) => new Set([...current, ...ids]));
    setFailed((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !ids.has(id)),
      ),
    );
    for (const { id, name } of channels) {
      let error: string | undefined;
      try {
        await change(id);
      } catch (cause) {
        error = message(cause);
      }
      setBusy((current) => new Set([...current].filter((key) => key !== id)));
      if (error !== undefined)
        setFailed((current) => ({ ...current, [id]: { name, error, join } }));
    }
  };
  const add = (channels: readonly ChannelSummary[]) =>
    run(channels, true, (id) => session.memberAdditions.add(id, bestie));
  const remove = (channel: ChannelSummary) =>
    run([channel], false, (id) => removeMember(session, id, bestie));
  const adding = addable.some((channel) => busy.has(channel.id));
  // A failure stops showing once the channel is as the change wanted anyway.
  const inBestie = new Set(joined.map((channel) => channel.id));
  const problems = Object.entries(failed).filter(
    ([id, { join }]) => inBestie.has(id) !== join,
  );

  return (
    <>
      <InlineHeader
        title="Private channels Bestie can read"
        subtitle="Bestie already reads every public channel. In a channel you add it to, it reads along but answers only when mentioned."
        actions={
          <>
            <MenuRoot>
              <MenuTrigger
                disabled={!addable.length}
                render={<Button variant="outline">Add to a channel…</Button>}
              />
              <MenuPopup align="end">
                {addable.map((channel) => (
                  <MenuItem
                    key={channel.id}
                    disabled={busy.has(channel.id)}
                    onClick={() => void add([channel])}
                  >
                    #{channel.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </MenuRoot>
            <Button
              variant="outline"
              disabled={!addable.length}
              loading={adding}
              onClick={() => setConfirming(addable)}
            >
              Add to all my private channels
            </Button>
          </>
        }
      />
      <SettingsGroup>
        {joined.map((channel) => (
          <PreferenceRow
            key={channel.id}
            title={`#${channel.name}`}
            trailing={
              <Button
                variant="outline"
                loading={busy.has(channel.id)}
                disabled={channel.cached}
                aria-label={`Remove Bestie from #${channel.name}`}
                onClick={() => void remove(channel)}
              >
                Remove
              </Button>
            }
          />
        ))}
        {!joined.length && (
          <PreferenceRow
            title="Not in any of your private channels yet"
            subtitle="Add Bestie to the ones you want it to catch you up on."
          />
        )}
        <SwitchPreferenceRow
          label="Also add Bestie to private channels I create"
          description="Coming later."
          checked={false}
          disabled
        />
      </SettingsGroup>
      {problems.length > 0 && (
        <div role="alert" className="buzz-field-error">
          {problems.map(([id, { name, error }]) => (
            <p key={id}>
              #{name}: {error}
            </p>
          ))}
        </div>
      )}
      {confirming && (
        <AlertDialog
          title={`Add Bestie to ${confirming.length} private ${confirming.length === 1 ? "channel" : "channels"}?`}
          description="Members of each channel will see that you added Bestie."
          onClose={() => setConfirming(undefined)}
          actions={
            <>
              <Button onClick={() => setConfirming(undefined)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirming(undefined);
                  void add(confirming);
                }}
              >
                Add to all
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
