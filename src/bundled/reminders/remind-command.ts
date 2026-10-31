import type { SlashCommand } from "../../features/conversation/contracts";
import type { RelayData } from "../../features/relay/service";
import { formatDue } from "./model";
import {
  createRemindZone,
  parseRemind,
  REMIND_PARSE_MESSAGES,
  type RemindParseError,
} from "./remind-time";

const USAGE = "/remind me <what> <when>";

function refusal(error: RemindParseError) {
  const message = REMIND_PARSE_MESSAGES[error];
  if (error === "notPersonal" && message) return message;
  return message ? `${message} Usage: ${USAGE}` : `Usage: ${USAGE}`;
}

/**
 * `/remind me <what> <when>`: a standalone reminder, a note and a due time
 * with no target message. `timeZone` and `now` default to the device's zone and
 * clock; tests pin them.
 */
export function remindCommand(options: {
  relay: RelayData;
  timeZone?: string;
  now?: () => number;
}): SlashCommand {
  const { relay, timeZone, now = Date.now } = options;
  return {
    id: "remind",
    name: "remind",
    usage: USAGE,
    description: "Set a reminder for yourself",
    async run({ args, scope, signal }) {
      const parsed = parseRemind(args, {
        now: now(),
        zone: createRemindZone(timeZone),
      });
      if (!parsed.ok) throw new Error(refusal(parsed.error));
      const connection = relay.snapshot();
      const reminders =
        connection.status === "ready" && connection.scope === scope
          ? connection.session.reminders
          : undefined;
      if (!reminders) throw new Error("Reminders are not available right now.");
      signal.throwIfAborted();
      const dueAt = Math.floor(parsed.dueAt / 1000);
      await reminders.create(undefined, dueAt, parsed.note);
      return {
        done: true,
        notice: `Reminder set for ${formatDue(dueAt, timeZone)}`,
      };
    },
  };
}
