import { useEffect, useState } from "react";
import type { LoginSnapshot } from "../session";

/** Give browser sign-in a quiet start, then expose guidance and cancellation. */
export function useSignInProgress(login: LoginSnapshot) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (login.status !== "pending" || login.checking) return;
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [login.status, login.checking]);
  const pending = login.status === "pending";
  return { pending, waiting: pending && !login.checking && slow };
}
