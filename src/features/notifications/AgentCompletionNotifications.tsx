import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppServices } from "../../app/services";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { splitPartition } from "../relay/partition";
import {
  bindAgentCompletionNotifications,
  completionBody,
  completionSourceKey,
  completionTarget,
  completionTitle,
  completionToast,
  isViewingCompletedWork,
} from "./agent-completions";

export function AgentCompletionNotifications({
  services,
}: {
  services: Pick<
    AppServices,
    "agentActivity" | "agents" | "navigation" | "notifications"
  >;
}) {
  const notify = useToastNotification();
  useEffect(
    () =>
      bindAgentCompletionNotifications(services.agentActivity, {
        focused: () =>
          isTauri() ? getCurrentWindow().isFocused() : document.hasFocus(),
        active: () => services.navigation.snapshot().entry.target,
        target: (work) => completionTarget(work, splitPartition(work.scope)),
        desktop: (work, target) => {
          const name = agentName(services, work.agent);
          void services.notifications.admit(
            "agent",
            "Solo chat completions",
            {
              sourceKey: completionSourceKey(work),
              target,
            },
            () => true,
            () =>
              !(
                document.hasFocus() &&
                isViewingCompletedWork(
                  services.navigation.snapshot().entry.target,
                  target,
                )
              ),
            () => ({
              title: completionTitle(name, work),
              body: completionBody(work),
            }),
            (activate) =>
              notify(
                completionToast(name, work),
                work.state === "error" ? "error" : "success",
                { label: "View", onClick: activate },
              ),
          );
        },
      }),
    [notify, services],
  );
  return null;
}

function agentName(
  services: Pick<AppServices, "agents">,
  pubkey: string,
): string {
  return (
    services.agents.local().agents.find((agent) => agent.pubkey === pubkey)
      ?.name ?? "Agent"
  );
}
