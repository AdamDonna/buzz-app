/** `¯\_(ツ)_/¯` escaped so every CommonMark renderer shows it verbatim. */
export const SHRUG = "¯\\\\\\_(ツ)\\_/¯";

export const shrug = (text: string) => (text ? `${text} ${SHRUG}` : SHRUG);
