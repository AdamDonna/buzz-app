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
    ? "Loading revision count…"
    : tracks.some((track) => track?.failed)
      ? "Revision count unavailable"
      : `${count.toLocaleString()}${tracks.some((track) => !track?.done) ? "+" : ""} ${count === 1 ? "revision" : "revisions"}`;
  return (
    <Accordion
      variant="settings"
      keepMounted
      items={[
        {
          value: "Config history",
          title: (
            <span className="grid gap-1 text-left">
              <span>Config history</span>
              <span className="text-caption text-secondary">{summary}</span>
            </span>
          ),
          content: (
            <div className="grid gap-6">
              {history.sides.map(({ side, expected, head, version }) => (
                <AgentConfigHistory
                  key={`${expected.channel}/${expected.d}`}
                  title={
                    side === "settings"
                      ? "Settings history"
                      : "Instructions history"
                  }
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
