import { Button } from "../../shared/design-system/ui/Button";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";

/** Create and link a key, or import one, with automatic Builderlab backup. */
export function KeyChoice({
  email,
  onCreate,
  onImport,
  onSwitchAccount,
}: {
  email?: string | undefined;
  /** Create the key, link it to the account, then back it up. */
  onCreate: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
  /** Wrong account: sign the session out and return to the landing. */
  onSwitchAccount: () => void;
}) {
  // The welcome screen's create-or-import stack, after sign-in.
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.importContent}>
          <h1
            id="welcome-title"
            tabIndex={-1}
            className="text-heading text-standard"
          >
            Get started with Buzz
          </h1>
          <p className="text-body text-subtle">
            Your identity in Buzz will be managed by your account. If this is
            your first time using Buzz we can set your identity up for you.
          </p>
          {email && (
            <p className="break-words text-body-sm text-subtle">
              Signed in as {email}
            </p>
          )}
        </div>
      }
    >
      <Button variant="prominent" size="lg" onClick={onCreate}>
        Set me up
      </Button>
      <Button
        variant="subtle"
        size="lg"
        data-return-focus="import"
        onClick={onImport}
      >
        Use an existing key
      </Button>
      <Button variant="ghost" size="lg" onClick={onSwitchAccount}>
        Use a different account
      </Button>
    </OnboardingScreen>
  );
}
