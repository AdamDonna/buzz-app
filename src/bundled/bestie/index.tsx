import type { ReactNode } from "react";
import type { PluginModule } from "../../plugins/api";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { useSavedAgentState } from "../../features/solo/default-agent";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { onBestieMade } from "../agents/BestieChoice";
import { bestieTab, formerBestieTab } from "./BestieTab";
import { rememberNewBestie, stopFormerCheckIns } from "./former";
import { BestieChooser, type BestieChooserProps } from "./ChooseBestie";
import { PinnedBestie } from "./PinnedBestie";
import { bestieRoute } from "./routes";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "agents",
  "conversation",
  "panels",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.agents.registerTab(bestieTab(ctx.relay, ctx.agents));
  ctx.agents.registerTab(formerBestieTab(ctx.relay, ctx.agents));
  // Whoever is Bestie, on any device, only it checks in.
  ctx.effect(() => stopFormerCheckIns(ctx.relay, ctx.agents));
  // A Bestie made on this device starts out remembering its owner. One made
  // elsewhere keeps what it has, so memory turned off stays off.
  ctx.effect(() =>
    onBestieMade((pubkey) => {
      rememberNewBestie(ctx.relay, ctx.agents, pubkey).catch((error) =>
        console.warn("Bestie's memory wasn't turned on", error),
      );
    }),
  );
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: (params) => !!bestieRoute(params) },
    component: ({ navigation: pageNavigation }) => (
      <BestieDestination
        relay={ctx.relay}
        navigation={ctx.navigation}
        extensions={ctx.conversation}
        host={ctx}
        agents={ctx.agents}
        pageNavigation={pageNavigation}
      />
    ),
  });
};

function BestieStatus({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Bestie"
                icon={<BestieIcon size="1rem" />}
              />
            }
          />
          <Intro>{children}</Intro>
        </div>
      </FullPageSurface>
    </div>
  );
}

function BestieDestination({
  relay,
  ...props
}: {
  relay: RelayData;
  navigation: Navigation;
  extensions: ConversationExtensions;
  host: ConversationHostServices;
  agents: Agents;
  pageNavigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const saved = useSavedAgentState(connection.session, connection.scope ?? "");
  const established =
    connection.status === "ready" &&
    !!connection.viewer &&
    !!connection.scope?.endsWith(`:${connection.viewer}`);
  if (!established && !saved.agent)
    return (
      <BestieStatus>
        <p className="m-0 text-body-sm text-muted" role="status">
          {connection.status === "connecting"
            ? "Connecting to your Bestie…"
            : (connection.error ??
              "Choose a community to continue with your Bestie.")}
        </p>
        {connection.status === "error" && (
          <Button onClick={relay.retry}>Retry connection</Button>
        )}
      </BestieStatus>
    );
  if (!saved.read || saved.error)
    return (
      <BestieStatus>
        <p
          className="m-0 text-body-sm text-muted"
          role={saved.error ? "alert" : "status"}
        >
          {saved.error ?? "Loading your Bestie…"}
        </p>
        {saved.error && <Button onClick={saved.retry}>Try again</Button>}
      </BestieStatus>
    );
  return saved.agent ? (
    <PinnedBestie
      relay={relay}
      agents={props.agents}
      host={props.host}
      extensions={props.extensions}
      navigator={props.navigation}
      navigation={props.pageNavigation}
    />
  ) : (
    <ChooseBestie
      session={connection.session}
      scope={connection.scope ?? ""}
      community={connection.origin}
      {...props}
    />
  );
}

function ChooseBestie(props: BestieChooserProps) {
  return (
    <BestieStatus>
      <h2 className="m-0 text-heading">Choose your bestie</h2>
      <p className="m-0 text-body-sm text-muted">
        Select or create an agent to be your bestie in Buzz. They’ll get special
        placement and extra capabilities throughout the app.
      </p>
      <BestieChooser {...props} />
    </BestieStatus>
  );
}

function Intro({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6" data-bestie-intro="">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
        <img src="/bestie.png" alt="" className="size-20 object-contain" />
        {children}
      </div>
    </div>
  );
}
