import { createContext } from "react";
import type { MentionRecipient } from "./mention-draft";
/** Selected keys participate in naming even if no longer eligible for another selection. */
export const SelectedMentionContext = createContext<
  readonly MentionRecipient[]
>([]);
/** Host task toolbar state; separate from authored mention intent. */
export const TaskRecipientContext = createContext<
  | {
      pubkey?: string | undefined;
      selectPrimary?: ((pubkey: string) => boolean) | undefined;
      eligible?: ((pubkey: string) => boolean) | undefined;
    }
  | undefined
>(undefined);
