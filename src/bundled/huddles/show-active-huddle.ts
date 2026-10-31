/** Brings the running call forward: its mini player if shown, else its window. */
export async function showActiveHuddle(showWindow: () => Promise<void>) {
  const capsule = document.getElementById("huddle-capsule");
  if (capsule) capsule.focus();
  else await showWindow();
}
