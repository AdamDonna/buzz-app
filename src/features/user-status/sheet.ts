/** Opens the set-status sheet owned by the profile menu. */
export type StatusSheet = Readonly<{
  /** False when no sheet can open: it is unmounted or statuses are not writable. */
  open(): boolean;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    statusSheet: StatusSheet;
  }
}

export function createStatusSheet() {
  let opener: (() => boolean) | undefined;
  return {
    sheet: Object.freeze({ open: () => opener?.() ?? false }) as StatusSheet,
    /** The profile menu binds the sheet it renders; the latest binding wins. */
    bind(open: () => boolean) {
      opener = open;
      return () => {
        if (opener === open) opener = undefined;
      };
    },
  };
}
