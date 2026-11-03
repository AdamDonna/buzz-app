import type { JsonValue, OpenTarget } from "../navigation/targets";
import { splitPartition } from "../relay/partition";

/** An unsent Solo conversation: nothing exists on the relay until its first send. */
export type SoloDraft = Readonly<{
  project?: string;
  agent?: string;
  linked?: string;
  task?: Readonly<{ region: string; draftId: string }>;
}>;

const agentKey = /^[0-9a-f]{64}$/;

export function soloDraft(
  params: JsonValue | undefined,
): SoloDraft | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  if (value.kind !== "solo-draft") return;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "kind" &&
        key !== "project" &&
        key !== "agent" &&
        key !== "task" &&
        key !== "linked",
    )
  )
    return;
  const { project, agent, linked } = value;
  let task: NonNullable<SoloDraft["task"]> | undefined;
  if (value.task !== undefined) {
    if (
      !value.task ||
      typeof value.task !== "object" ||
      Array.isArray(value.task)
    )
      return;
    const input = value.task as { readonly [key: string]: JsonValue };
    if (
      Object.keys(input).some((key) => key !== "region" && key !== "draftId") ||
      typeof input.region !== "string" ||
      !/^buzz\.region:[a-z0-9.-]+:[a-z0-9.-]+$/.test(input.region) ||
      typeof input.draftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.draftId,
      ) ||
      project ||
      linked
    )
      return;
    task = { region: input.region, draftId: input.draftId };
  }
  if (
    linked !== undefined &&
    (typeof linked !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        linked,
      ))
  )
    return;
  if (
    project !== undefined &&
    (typeof project !== "string" || !project || project.length > 256)
  )
    return;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || !agentKey.test(agent))
  )
    return;
  return {
    ...(project ? { project } : {}),
    ...(agent ? { agent } : {}),
    ...(linked ? { linked } : {}),
    ...(task ? { task } : {}),
  };
}

export function isChannelRoute(params: JsonValue) {
  return (
    params === "new-message" ||
    params === "empty" ||
    soloDraft(params) !== undefined
  );
}

/** A new Solo conversation, optionally filed in a project or starting with an agent. */
export function soloDraftTarget(
  scope: string,
  draft: SoloDraft = {},
): OpenTarget {
  const parts = splitPartition(scope);
  const params = { kind: "solo-draft", ...draft };
  if (!parts || !soloDraft(params)) throw new Error("Invalid Solo destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: parts,
    route: { version: 1, params },
  };
}

export function conversationTarget(
  scope: string,
  channelId: string,
): OpenTarget {
  const parts = splitPartition(scope);
  if (!parts) throw new Error("Invalid conversation destination");
  return { version: 1, kind: "conversation", scope: parts, channelId };
}
