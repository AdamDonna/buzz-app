import { useState } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useAgents } from "../../features/agents/react";
import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { BESTIE_LOCAL_ONLY, chooseBestie } from "../agents/BestieChoice";

export type BestieChooserProps = {
  session: RelaySession;
  scope: string;
  community?: string | undefined;
  agents: Agents;
};

/** Picks or creates the viewer's Bestie, where there is none to replace: on
 * the empty Bestie page, and in place of one that is no longer here. */
export function BestieChooser({
  session,
  scope,
  community,
  agents,
}: BestieChooserProps) {
  const choices = useAgentChoices(session, true, true);
  const { snapshot, types } = useAgents(agents);
  const [selecting, setSelecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Only an agent on this device can be Bestie for now: a remote one isn't
  // set up for it yet.
  const here = (pubkey: string) =>
    agents
      .snapshot()
      .agents.some(
        (agent) => agent.pubkey === pubkey && agent.place === "here",
      );
  const local = choices.selectable.filter((agent) =>
    snapshot.agents.some(
      (each) => each.pubkey === agent.pubkey && each.place === "here",
    ),
  );
  const choose = async (pubkey: string) => {
    if (
      !session.agentChoices
        .snapshot()
        .selectable.some((agent) => agent.pubkey === pubkey)
    ) {
      setError("That agent is no longer available. Choose another.");
      return;
    }
    if (!here(pubkey)) {
      setError(BESTIE_LOCAL_ONLY);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await chooseBestie(session, scope, pubkey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {selecting ? (
        <div className="flex w-full max-w-sm flex-col items-center gap-3">
          <Select
            label="Your agents"
            variant="field"
            value=""
            placeholder={
              choices.pending ? "Loading agents…" : "Choose your bestie"
            }
            disabled={saving || choices.pending || !local.length}
            groups={[
              {
                label: "Your agents",
                options: local.map((agent) => ({
                  value: agent.pubkey,
                  label: agent.managedName ?? agent.name,
                })),
              },
            ]}
            onValueChange={(pubkey) => void choose(pubkey)}
          />
          <p className="m-0 text-body-sm text-muted">{BESTIE_LOCAL_ONLY}</p>
          <Button
            variant="link"
            size="inline"
            onClick={() => setCreating(true)}
          >
            New agent
          </Button>
          {choices.error && (
            <>
              <p className="m-0 text-body-sm text-danger" role="alert">
                {choices.error}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError("");
                  void session.agentChoices
                    .refresh(true, { fresh: true })
                    .catch((reason) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    );
                }}
              >
                Try again
              </Button>
            </>
          )}
          {error && (
            <p className="m-0 text-body-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <Button variant="prominent" onClick={() => setSelecting(true)}>
          Choose your bestie
        </Button>
      )}
      {creating && (
        <AgentCreateDialog
          agents={agents}
          types={types}
          community={community}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            void session.agentChoices
              .refresh(true, { fresh: true })
              .then(() => choose(agent.pubkey))
              .catch((reason) =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              );
          }}
        />
      )}
    </>
  );
}
