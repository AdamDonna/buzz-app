import { useCallback, useState, useSyncExternalStore } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { AgentConfigHistory } from "./AgentConfigHistory";
import type { History } from "./agent-config-history";
import type { Agents, ConfigHistory } from "./service";

/** One settings disclosure; each track keeps its existing history owner. */
export function AgentConfigHistoryRow({
  agents,
  pubkey,
}: {
  agents: Pick<Agents, "configHistory" | "snapshot" | "subscribe">;
  pubkey: string;
}) {
  useSyncExternalStore(agents.subscribe, agents.snapshot);
  const history = agents.configHistory(pubkey);
  return history ? <HistoryRow key={pubkey} history={history} /> : null;
}

function HistoryRow({ history }: { history: ConfigHistory }) {
  const [counts, setCounts] = useState<
    Partial<Record<"settings" | "instructions", History>>
  >({});
  const settingsChanged = useCallback((value: History) => {
    setCounts((current) => ({ ...current, settings: value }));
  }, []);
  const instructionsChanged = useCallback((value: History) => {
    setCounts((current) => ({ ...current, instructions: value }));
  }, []);
  const tracks = history.sides.map(({ side }) => counts[side]);
  const count = tracks.reduce(
    (total, track) => total + (track?.revisions.length ?? 0),
    0,
  );
  const summary = tracks.some(
    (track) => !track || (!track.next && !track.failed),
  )
    ? "Loading versions…"
    : tracks.some((track) => track?.failed)
      ? "Version count unavailable"
      : `${count.toLocaleString()}${tracks.some((track) => !track?.done) ? "+" : ""} ${count === 1 ? "version" : "versions"}`;
  return (
    <Accordion
      variant="settings"
      keepMounted
      items={[
        {
          value: "Previous versions",
          title: (
            <span className="flex items-center justify-between gap-3 text-body-sm text-left">
              <span>Previous versions</span>
              <span className="text-secondary">{summary}</span>
            </span>
          ),
          content: (
            <div className="grid gap-2">
              <p className="m-0 text-caption text-secondary">
                Versions are kept automatically when changes are saved.
              </p>
              {history.sides.map(({ side, expected, head, version }) => (
                <AgentConfigHistory
                  key={`${expected.channel}/${expected.d}`}
                  title={side === "settings" ? "Settings" : "Instructions"}
                  expected={expected}
                  head={head}
                  version={version}
                  read={history.read}
                  {...(side === "settings" && history.settings
                    ? { settings: history.settings }
                    : {})}
                  onRevert={(template) => history.revise(side, template)}
                  onHistoryChange={
                    side === "settings" ? settingsChanged : instructionsChanged
                  }
                />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}
