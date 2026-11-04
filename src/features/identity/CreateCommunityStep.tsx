import { useState } from "react";
import {
  CommunityAddressField,
  useCommunityAddress,
} from "../../bundled/builderlab/communities/CommunityAddress";
import { Button } from "../../shared/design-system/ui/Button";
import type { FirstRunAccount } from "./builderlab-account";
import { OnboardingBack } from "./OnboardingBack";
import { WireframePanel } from "./Wireframe";

/**
 * First run's Create a community, offered from Join a community: the address
 * field and availability check of the Builderlab communities section, then
 * its create. `onCreated` receives the new community's origin, which joins as
 * an entered address does.
 */
export function CreateCommunityStep({
  account,
  onCreated,
  onBack,
}: {
  account: Pick<FirstRunAccount, "communityAvailable" | "createCommunity">;
  onCreated: (origin: string) => void;
  onBack: () => void;
}) {
  const address = useCommunityAddress(account.communityAvailable, true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!address.ready || busy) return;
        setBusy(true);
        setError("");
        account.createCommunity(address.name).then(onCreated, (reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          setBusy(false);
        });
      }}
    >
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Create a community
        </h1>
        <p className="mt-2 text-body text-subtle">
          Choose the address your team will use to connect.
        </p>
      </div>
      <WireframePanel>
        <CommunityAddressField address={address} busy={busy} />
      </WireframePanel>
      {error && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        <OnboardingBack onClick={onBack} disabled={busy} />
        <Button
          type="submit"
          size="lg"
          variant="prominent"
          loading={busy}
          disabled={!address.ready}
        >
          Create community
        </Button>
      </div>
    </form>
  );
}
