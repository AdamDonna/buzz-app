import { canAddMembers } from "../../features/channel-members/members";
import { canRemoveMember } from "../../features/channel-members/administration-protocol";
import {
  emptyChannelsTarget,
  successorChannel,
} from "../../features/channel-navigation/channel-successor";
import { conversationTarget } from "../../features/channel-navigation/routes";
import { sidebarOrder } from "../../features/channel-navigation/sidebar-order";
import type {
  SlashCommand,
  SlashCommandAvailabilityContext,
  SlashCommandContext,
} from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import type { OpenTarget } from "../../features/navigation/targets";
import { splitPartition } from "../../features/relay/partition";
import { writeView } from "../../shared/view-state";

type Place = Pick<SlashCommandAvailabilityContext, "session" | "channelId">;
type Person = SlashCommandContext["recipients"][number];

const CHANNEL_SCOPES = ["channel", "thread"] as const;

function channelOf(session: Place["session"], id: string) {
  return (
    session.channels.list().channels.find((channel) => channel.id === id) ??
    session.channels.get?.(id)
  );
}

/** A channel the viewer can act on as a member: not a DM, Solo chat or archive. */
function ordinary({ session, channelId }: Place) {
  const channel = channelOf(session, channelId);
  return channel &&
    !channel.archived &&
    !channel.cached &&
    (channel.channelType === "stream" ||
      channel.channelType === "forum" ||
      channel.channelType === "system")
    ? channel
    : undefined;
}

function sidebarOrderOf(session: Place["session"], scope: string) {
  return sidebarOrder({
    scope,
    channels: session.channels.list().channels,
    preferences: session.sidebarPreferences?.snapshot().data,
    hiddenDms: session.channelLifecycle?.snapshot().hidden,
  });
}

const listNames = (names: readonly string[]) =>
  new Intl.ListFormat("en").format(names);

function distinct(people: readonly Person[]) {
  const seen = new Set<string>();
  return people.filter(({ pubkey }) => !seen.has(pubkey) && seen.add(pubkey));
}

/** Throws unless the arguments are exactly the draft's mentions: every person
 * is named in them and nothing else is, so neither a name that did not resolve
 * nor a person the text does not mention is silently acted on or dropped. */
function mentioned(usage: string, args: string, recipients: readonly Person[]) {
  const people = distinct(recipients);
  const optionallyEscaped = (text: string) =>
    [...text]
      .map((char) => `\\\\?${char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      .join("");
  const longestFirst = [...people].sort(
    (a, b) => b.name.length - a.name.length,
  );
  const mention = (name: string, flags: string) =>
    new RegExp(`@${optionallyEscaped(name)}`, flags);
  let rest = args;
  let unnamed = false;
  for (const { name } of longestFirst) {
    const next = rest.replace(mention(name, ""), "");
    unnamed ||= next === rest;
    rest = next;
  }
  for (const { name } of longestFirst)
    rest = rest.replace(mention(name, "g"), "");
  if (!people.length || unnamed || rest.trim())
    throw new Error(`Mention each person with @. Usage: ${usage}`);
  return people;
}

const channelLink = /^\[(?:\\.|[^\]\\])*\]\((buzz:\/\/channel\/[^)\s]+)\)$/;

function channelReference(args: string) {
  const link = channelLink.exec(args.trim())?.[1];
  const parsed = link ? parseBuzzLink(link) : null;
  if (parsed?.format !== "legacy" || parsed.messageId)
    throw new Error("Pick the channel from the # list. Usage: /join #channel");
  return parsed.channelId;
}

function open(navigation: Navigation, target: OpenTarget) {
  return () => void navigation.open(target);
}

/** `/invite`, `/remove`, `/join`, `/leave` and `/who` over the services the
 * channel UI already uses. Each failure throws, so the draft stays. */
export function membershipCommands(navigation: Navigation): SlashCommand[] {
  return [
    {
      id: "invite",
      name: "invite",
      usage: "/invite @user…",
      description: "Add people to this channel",
      scopes: CHANNEL_SCOPES,
      mentionsAreArguments: true,
      available: ({ session, channelId }) =>
        canAddMembers(session, channelOf(session, channelId)),
      async run({ session, channelId, args, recipients, signal }) {
        const people = mentioned("/invite @user…", args, recipients);
        const members = new Set(channelOf(session, channelId)?.members);
        const adding = people.filter(({ pubkey }) => !members.has(pubkey));
        if (!adding.length)
          return {
            done: true,
            notice: `${listNames(people.map(({ name }) => name))} ${people.length === 1 ? "is" : "are"} already in this channel.`,
          };
        const added: string[] = [];
        const failed: string[] = [];
        for (const person of adding) {
          signal.throwIfAborted();
          try {
            await session.memberAdditions.add(channelId, person.pubkey);
            added.push(person.name);
          } catch (reason) {
            signal.throwIfAborted();
            failed.push(`${person.name} (${why(reason)})`);
          }
        }
        if (failed.length)
          throw new Error(
            `${added.length ? `Added ${listNames(added)}. ` : ""}Couldn't add ${failed.join(", ")}.`,
          );
        return { done: true, notice: `Added ${listNames(added)}.` };
      },
    },
    {
      id: "remove",
      name: "remove",
      aliases: ["kick"],
      usage: "/remove @user…",
      description: "Remove people from this channel",
      scopes: CHANNEL_SCOPES,
      mentionsAreArguments: true,
      available: ({ session, channelId }) => {
        const role = ordinary({ session, channelId })?.viewerRole;
        return (
          !!session.memberAdministration?.available &&
          (role === "owner" || role === "admin")
        );
      },
      async run({ session, channelId, args, recipients, signal }) {
        const people = mentioned("/remove @user…", args, recipients);
        const administration = session.memberAdministration;
        if (!administration?.available || !session.viewer)
          throw new Error(
            "Removing members is unavailable on this connection.",
          );
        await administration.refresh(channelId);
        signal.throwIfAborted();
        const loaded = administration.snapshot(channelId);
        if (loaded.status !== "ready")
          throw new Error(
            loaded.error ?? "Member roles are unavailable. Try again.",
          );
        const removed: string[] = [];
        const absent: string[] = [];
        const failed: string[] = [];
        for (const { pubkey, name } of people) {
          signal.throwIfAborted();
          if (pubkey === session.viewer) {
            failed.push(`${name} (you can't remove yourself; use /leave)`);
            continue;
          }
          const { authority } = administration.snapshot(channelId);
          if (!Object.keys(authority.roles).length) {
            failed.push(`${name} (member roles are unavailable)`);
            continue;
          }
          const role = authority.roles[pubkey];
          if (!role) {
            absent.push(name);
            continue;
          }
          const refusal =
            role === "owner"
              ? "owners can't be removed"
              : !canRemoveMember(authority, session.viewer, pubkey)
                ? "you can't remove this member"
                : undefined;
          if (refusal) {
            failed.push(`${name} (${refusal})`);
            continue;
          }
          try {
            await administration.run(
              channelId,
              { pubkey, expectedRole: role, role: "remove" },
              signal,
            );
          } catch (reason) {
            signal.throwIfAborted();
            failed.push(`${name} (${why(reason)})`);
            continue;
          }
          const { operation, error } = administration.snapshot(channelId);
          if (
            operation?.change.pubkey === pubkey &&
            operation.status === "confirmed"
          )
            removed.push(name);
          else failed.push(`${name} (${error ?? "not confirmed"})`);
        }
        const gone = absent.length
          ? `${listNames(absent)} ${absent.length === 1 ? "is" : "are"} already out of this channel.`
          : "";
        if (failed.length)
          throw new Error(
            [
              removed.length ? `Removed ${listNames(removed)}.` : "",
              gone,
              `Couldn't remove ${failed.join(", ")}.`,
            ]
              .filter(Boolean)
              .join(" "),
          );
        return {
          done: true,
          notice: [removed.length ? `Removed ${listNames(removed)}.` : "", gone]
            .filter(Boolean)
            .join(" "),
        };
      },
    },
    {
      id: "join",
      name: "join",
      usage: "/join #channel",
      description: "Join an open channel and open it",
      async run({ session, scope, args, signal }) {
        const id = channelReference(args);
        const target = conversationTarget(scope, id);
        const known = channelOf(session, id);
        const member =
          !!session.viewer && !!known?.members?.includes(session.viewer);
        if (!member || known?.cached) {
          const lifecycle = session.channelLifecycle;
          if (!lifecycle?.available)
            throw new Error(
              "Joining channels is unavailable on this connection.",
            );
          await lifecycle.run("join", id, signal);
        }
        return { done: true, after: open(navigation, target) };
      },
    },
    {
      id: "leave",
      name: "leave",
      aliases: ["part"],
      usage: "/leave",
      description: "Leave this channel",
      scopes: CHANNEL_SCOPES,
      available: ({ session, channelId }) => {
        const channel = channelOf(session, channelId);
        return (
          !!session.channelLifecycle?.available &&
          !!session.viewer &&
          !!channel &&
          !channel.cached &&
          (channel.channelType === "stream" ||
            channel.channelType === "forum" ||
            channel.channelType === "system") &&
          (!channel.members || channel.members.includes(session.viewer))
        );
      },
      async run({ session, scope, channelId, signal }) {
        const lifecycle = session.channelLifecycle;
        if (!lifecycle?.available)
          throw new Error(
            "Leaving channels is unavailable on this connection.",
          );
        const name = channelOf(session, channelId)?.name;
        const neighbors = sidebarOrderOf(session, scope).neighbors(channelId);
        await lifecycle.run("leave", channelId, signal);
        // The composer goes with the channel, so the move cannot wait for
        // `after`. Like the sidebar's leave, it moves only a viewer still on
        // this channel.
        const here = navigation.snapshot().entry.target;
        if (here.kind === "conversation" && here.channelId === channelId) {
          const next = successorChannel(
            neighbors,
            sidebarOrderOf(session, scope).listed,
            channelId,
          );
          if (!next) writeView(scope, "selected-channel", undefined);
          await navigation.open(
            next ? conversationTarget(scope, next) : emptyChannelsTarget(),
          );
        }
        return {
          done: true,
          notice: name ? `Channel left: ${name}` : "Channel left",
        };
      },
    },
    {
      id: "who",
      name: "who",
      aliases: ["members"],
      usage: "/who",
      description: "Open the member list",
      run({ scope, channelId }) {
        const parts = splitPartition(scope);
        if (!parts) throw new Error("Invalid conversation destination");
        return {
          done: true,
          after: open(navigation, {
            version: 1,
            kind: "conversation",
            scope: parts,
            channelId,
            panel: "members",
          }),
        };
      },
    },
  ];
}

const why = (reason: unknown) =>
  reason instanceof Error && reason.message.trim()
    ? reason.message.replace(/\.$/, "")
    : "unknown error";
