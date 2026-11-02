import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause on a found community that this build's Builderlab does not host (one
 * it hosts signs in at once), before any sign-in: the relay cannot sign the
 * user in, but Buzz still needs a key. Connect runs the build portal's sign-in
 * exactly as the landing's button does (the key it creates is linked to that
 * account and backed up there); the import brings a key with no account to
 * link it to. A community another Builderlab hosts offers only the import:
 * this build must not link or back up a key for it. Either way setup ends on
 * Join Community for the found address.
 */
export function ConnectChoice({
  host,
  elsewhere,
  onConnect,
  onImport,
  onBack,
}: {
  /** The found community's host, as the find page shows it. */
  host: string;
  /**
   * The portal host of the other Builderlab that runs this community; this
   * build must not sign in for it, so only a key is offered.
   */
  elsewhere?: string | undefined;
  /** Sign in at the build portal and continue as the landing’s Sign in with email does. */
  onConnect: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
  /** Return to the landing with the address kept. */
  onBack: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Connect to your community
        </h1>
        {/* The host stands apart from the title so a long one wraps on its own
            line and the title reads as one phrase to assistive technology. */}
        <p className="mt-2 break-all font-mono text-mono-lg text-standard">
          {host}
        </p>
        <p className="mt-2 text-body text-subtle">
          {elsewhere
            ? `This community belongs to a different Builderlab, at ${elsewhere}. Sign in with that organization’s Buzz app, or continue here with a key you already have.`
            : "Buzz relies on a key for your identity."}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {elsewhere ? (
          <Button
            variant="prominent"
            size="lg"
            data-return-focus="import"
            onClick={onImport}
          >
            I already have a key
          </Button>
        ) : (
          <>
            <Button variant="prominent" size="lg" onClick={onConnect}>
              Sign in with email
            </Button>
            {/* The secondary choice is deliberately smaller than the primary. */}
            <Button size="sm" data-return-focus="import" onClick={onImport}>
              I already have a key
            </Button>
          </>
        )}
      </div>
      <div className="flex gap-3">
        <Button onClick={onBack}>Back</Button>
      </div>
    </>
  );
}
