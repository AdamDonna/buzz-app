import captureUrl from "../../features/huddle/capture.worklet.js?url&no-inline";
import type { AppServer } from "./rpc";

/** Codex owns voice; this graph only carries the seat's 48 kHz mono PCM. */
export async function openVoice(
  rpc: AppServer,
  threadId: string,
  signal: AbortSignal,
  output: (samples: number[]) => Promise<void>,
  ended: (error?: Error) => void,
  instructions: string,
) {
  signal.throwIfAborted();
  const peer = new RTCPeerConnection();
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 48000 });
  } catch (error) {
    peer.close();
    throw error;
  }
  const destination = context.createMediaStreamDestination();
  const sources = new Set<AudioBufferSourceNode>();
  let capture: AudioWorkletNode | undefined;
  let remote: MediaStreamAudioSourceNode | undefined;
  let next = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let starting: Promise<unknown> | undefined;
  let sending = false;
  let cancel!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = reject;
  });
  void cancelled.catch(() => {});
  const wait = <T>(operation: Promise<T>) =>
    Promise.race([operation, cancelled]);
  let off = () => {};
  let rejectConnected!: (error: Error) => void;
  const close = () => {
    if (closed) return closing;
    closed = true;
    signal.removeEventListener("abort", close);
    off();
    cancel(new Error("Voice connection closed"));
    rejectConnected(new Error("Voice connection closed"));
    peer.close();
    remote?.disconnect();
    if (capture) {
      capture.port.onmessage = null;
      capture.port.close();
      capture.disconnect();
    }
    for (const source of sources) {
      source.stop();
      source.disconnect();
    }
    for (const track of destination.stream.getTracks()) track.stop();
    destination.disconnect();
    closing = Promise.all([
      context.close().catch(() => {}),
      starting
        ?.catch(() => {})
        .then(() =>
          rpc.request("thread/realtime/stop", { threadId }).catch(() => {}),
        ),
    ]).then(() => {});
    return closing;
  };
  const fail = (error: Error) => {
    if (closed) return;
    close();
    ended(error);
  };
  const connected = new Promise<void>((resolve, reject) => {
    rejectConnected = reject;
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") resolve();
      if (["failed", "disconnected"].includes(peer.connectionState))
        fail(new Error("Codex voice disconnected"));
    };
  });
  void connected.catch(() => {});
  signal.addEventListener("abort", close, { once: true });
  const timeout = setTimeout(
    () => fail(new Error("Codex voice connection timed out")),
    30_000,
  );
  try {
    await wait(context.resume());
    await wait(context.audioWorklet.addModule(captureUrl));
    signal.throwIfAborted();
    if (closed) throw new Error("Voice connection closed");
    if (context.sampleRate !== 48000)
      throw new Error("Agent voice requires 48 kHz audio");
    capture = new AudioWorkletNode(context, "buzz-huddle-capture");
    capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (closed || sending) return;
      sending = true;
      void output(Array.from(data))
        .catch(fail)
        .finally(() => {
          sending = false;
        });
    };
    capture.connect(context.destination); // Existing capture worklet emits silence.
    peer.ontrack = ({ track }) => {
      if (closed || track.kind !== "audio" || !capture) return;
      remote?.disconnect();
      remote = context.createMediaStreamSource(new MediaStream([track]));
      remote.connect(capture);
    };
    for (const track of destination.stream.getTracks())
      peer.addTrack(track, destination.stream);
    peer.createDataChannel("oai-events");
    off = rpc.onMessage(({ method, params }) => {
      const p = params as
        | { threadId?: string; sdp?: string; message?: string }
        | undefined;
      if (method === "connection/closed")
        return fail(new Error(p?.message ?? "Codex closed"));
      if (p?.threadId !== threadId || closed) return;
      if (method === "thread/realtime/sdp" && p.sdp)
        void peer
          .setRemoteDescription({ type: "answer", sdp: p.sdp })
          .catch(fail);
      if (
        method === "thread/realtime/error" ||
        method === "thread/realtime/closed"
      )
        fail(new Error(p.message ?? "Codex voice ended"));
    });
    await wait(peer.setLocalDescription(await wait(peer.createOffer())));
    signal.throwIfAborted();
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Codex voice offer is missing");
    starting = rpc.request("thread/realtime/start", {
      threadId,
      transport: { type: "webrtc", sdp },
      version: "v3",
      outputModality: "audio",
      clientManagedHandoffs: false,
      realtimeStartInstructions: instructions,
    });
    await wait(starting);
    await connected;
    signal.throwIfAborted();
    return {
      close,
      input(samples: number[]) {
        if (
          closed ||
          !samples.length ||
          samples.length > 5760 ||
          next > context.currentTime + 0.2
        )
          return;
        const buffer = context.createBuffer(1, samples.length, 48000);
        buffer.copyToChannel(Float32Array.from(samples), 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        sources.add(source);
        source.onended = () => {
          sources.delete(source);
          source.disconnect();
        };
        next = Math.max(next, context.currentTime + 0.02);
        source.start(next);
        next += buffer.duration;
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
