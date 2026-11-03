/** Live Canvas size policy, shared by the app and the browser host.
 * Dependency-free so the broker and socket layer can load it natively.
 * `src-tauri/src/relay.rs` mirrors both values. */

/** Content of a live channel Canvas, in UTF-8 bytes. */
export const LIVE_CANVAS_BYTES = 256 * 1024;
export const LIVE_CANVAS_LIMIT = `${LIVE_CANVAS_BYTES / 1024} KiB`;

/** The relay's default WebSocket frame (`DEFAULT_MAX_FRAME_BYTES`). */
export const CANVAS_FRAME_BYTES = 512 * 1024;
/** The largest complete signed Canvas event: the frame less the
 * `["EVENT",…]` wrapper. Content within `LIVE_CANVAS_BYTES` can still escape
 * past it, so signed events are checked separately. */
export const CANVAS_MAX_EVENT_BYTES = CANVAS_FRAME_BYTES - 16;
