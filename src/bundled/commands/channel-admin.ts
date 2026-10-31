import { canMessageAgent } from "../../features/agents/choices";
import { conversationTarget } from "../../features/channel-navigation/routes";
import type {
  SlashCommand,
  SlashCommandAvailabilityContext,
} from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../../features/relay/channel-details-protocol";
import { validDirectMessageParticipants } from "../../features/relay/direct-message-policy";
import {
  CHANNEL_SCOPES,
  channelOf,
  distinct,
  listNames,
  open,
  optionallyEscaped,
  ordinary,
  why,
  type Person,
} from "./membership";

type Place = Pick<SlashCommandAvailabilityContext, "session" | "channelId">;

/** The roles that may rename and archive, as the channel settings UI reads them. */
function manageable(place: Place) {
  const role = ordinary(place)?.viewerRole;
  return role === "owner" || role === "admin";
}

const RENAME_USAGE = "/rename <name>";

/** The typed name as the channel settings field would submit it. */
function channelName(args: string, recipients: readonly Person[]) {
  if (recipients.length || /\n|\]\(buzz:\/\//.test(args))
    throw new Error(
      `A channel name is one line of plain text. Usage: ${RENAME_USAGE}`,
    );
  const name = canonicalDetailsName(args.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
  if (!name)
    throw new Error(`Say what to rename it to. Usage: ${RENAME_USAGE}`);
  const invalid = detailsDraftErrors({
    name,
    description: "",
    visibility: "public",
  }).name;
  if (invalid) throw new Error(invalid);
  return name;
}

const DM_USAGE = "/dm @user… [message]";

/** The leading mentions are who to message; whatever follows is the message. */
function directMessageArguments(args: string, recipients: readonly Person[]) {
  const pool = [...distinct(recipients)].sort(
    (a, b) => b.name.length - a.name.length,
  );
  const people: Person[] = [];
  let rest = args.trimStart();
  for (;;) {
    let consumed = 0;
    const next = pool.find((person) => {
      if (people.includes(person)) return false;
      const hit = new RegExp(
        `^@${optionallyEscaped(person.name)}(?=\\s|$)`,
      ).exec(rest);
      consumed = hit?.[0].length ?? 0;
      return !!hit;
    });
    if (!next) break;
    people.push(next);
    rest = rest.slice(consumed).trimStart();
  }
  if (!people.length)
    throw new Error(`Mention each person with @. Usage: ${DM_USAGE}`);
  return { people, message: rest.trim() };
}

/** `/rename`, `/archive`, `/mute` and `/dm` over the services the channel and
 * new-message UI already use. Each failure throws, so the draft stays. */
export function channelAdminCommands(navigation: Navigation): SlashCommand[] {
  return [
    {
      id: "rename",
      name: "rename",
      usage: RENAME_USAGE,
      description: "Rename this channel",
      scopes: CHANNEL_SCOPES,
      available: (place) =>
        !!place.session.channelDetails?.available && manageable(place),
      async run({ session, channelId, args, recipients, signal }) {
        const name = channelName(args, recipients);
        const details = session.channelDetails;
        if (!details?.available)
          throw new Error(
            "Renaming channels is unavailable on this connection.",
          );
        const current = await details.load(channelId, signal);
        signal.throwIfAborted();
        if (!current.canEdit) throw new Error("You can't rename this channel.");
        if (current.name === name)
          return {
            done: true,
            notice: `This channel is already named #${name}.`,
          };
        await details.save(current, { ...current, name }, signal);
        return { done: true, notice: `Renamed this channel to #${name}.` };
      },
    },
    {
      id: "archive",
      name: "archive",
      usage: "/archive",
      description: "Archive this channel for everyone",
      scopes: CHANNEL_SCOPES,
      available: (place) =>
        !!place.session.channelLifecycle?.available && manageable(place),
      async run({ session, channelId, signal, confirmChannelAction }) {
        const lifecycle = session.channelLifecycle;
        if (!lifecycle?.available)
          throw new Error(
            "Archiving channels is unavailable on this connection.",
          );
        if (!confirmChannelAction)
          throw new Error(
            "Archiving asks for confirmation, which isn't available here. Use the channel menu.",
          );
        const permissions = await lifecycle.load(channelId, signal);
        signal.throwIfAborted();
        if (!permissions.canArchive)
          throw new Error("You can't archive this channel.");
        return (await confirmChannelAction("archive", channelId)) ===
          "cancelled"
          ? { cancelled: true }
          : { done: true };
      },
    },
    {
      id: "mute",
      name: "mute",
      usage: "/mute",
      description: "Mute or unmute this conversation",
      async run({ session, channelId, signal }) {
        const preferences = session.sidebarPreferences;
        const loaded = preferences?.snapshot().data;
        if (!preferences?.muteWritable || !loaded)
          throw new Error("Muting is unavailable on this connection.");
        const muted = await preferences.setMute(
          channelId,
          !loaded.muted.includes(channelId),
          signal,
        );
        const channel = channelOf(session, channelId);
        const label =
          channel?.channelType === "dm" || !channel?.name
            ? "this conversation"
            : `#${channel.name}`;
        return {
          done: true,
          notice: muted.includes(channelId)
            ? `Muted ${label}.`
            : `Unmuted ${label}.`,
        };
      },
    },
    {
      id: "dm",
      name: "dm",
      aliases: ["msg"],
      mentionsAreArguments: true,
      usage: DM_USAGE,
      description: "Message people directly, opening the conversation",
      async run({ session, scope, args, recipients, signal }) {
        const { people, message } = directMessageArguments(args, recipients);
        const { viewer, directMessages } = session;
        if (!viewer || !directMessages.available || !directMessages.open)
          throw new Error("This connection cannot start direct messages.");
        const keys = people.map(({ pubkey }) => pubkey);
        if (keys.includes(viewer))
          throw new Error(`You can't message yourself. Usage: ${DM_USAGE}`);
        if (!validDirectMessageParticipants(keys, viewer))
          throw new Error("Choose between one and eight other people.");
        const controlled = new Set(
          session.agentChoices
            .snapshot()
            .identities.filter(canMessageAgent)
            .map((agent) => agent.pubkey),
        );
        const profiles = session.profiles.snapshot();
        const refused = people.filter(
          ({ pubkey }) =>
            profiles.get(pubkey)?.isAgent === true && !controlled.has(pubkey),
        );
        if (refused.length)
          throw new Error(
            `${listNames(refused.map(({ name }) => name))} ${refused.length === 1 ? "isn't an agent" : "aren't agents"} you can message.`,
          );
        const channelId = await directMessages.open(keys, signal);
        signal.throwIfAborted();
        if (message) {
          const names = listNames(people.map(({ name }) => name));
          if (!directMessages.delivered)
            throw new Error("This connection cannot start direct messages.");
          const sent = await session.messages.send(channelId, message, []);
          try {
            await directMessages.delivered(sent, channelId, signal);
          } catch (reason) {
            signal.throwIfAborted();
            const proven = directMessages.delivery?.(sent) === "failed";
            if (proven) await session.outbox?.dismiss?.(sent).catch(() => {});
            throw new Error(
              proven
                ? `Couldn't send your message to ${names} (${why(reason)}).`
                : `Couldn't confirm your message to ${names} (${why(reason)}). It may have been sent; check the conversation before trying again.`,
            );
          }
        }
        return {
          done: true,
          after: open(navigation, conversationTarget(scope, channelId)),
        };
      },
    },
  ];
}
