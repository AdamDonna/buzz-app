// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
  useChannelMenuActions,
} from "./ChannelNavigationState";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture(
  run: (
    action: string,
    id: string,
    signal?: AbortSignal,
  ) => Promise<void> = async () => {},
) {
  let ids = ["existing"];
  const session = () =>
    ({
      channels: { list: () => ({ channels: ids.map((id) => ({ id })) }) },
      sidebarPreferences: { setMute: async () => [] },
      channelLifecycle: { run },
    }) as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    scope: "community:viewer",
    viewer: "viewer",
    generation: 1,
    session: session(),
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as RelayData;
  return {
    relay,
    roster: (next: string[]) => {
      ids = next;
    },
    replace() {
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: session(),
      };
      for (const listener of listeners) listener();
    },
  };
}
function mount(relay: RelayData, toasts = false) {
  return renderHook(
    () => {
      const value = useChannelNavigation();
      if (!value) throw new Error("Missing channel navigation provider");
      return value;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          {toasts ? (
            <ToastProvider>
              <ChannelNavigationProvider relay={relay}>
                {children}
              </ChannelNavigationProvider>
            </ToastProvider>
          ) : (
            <ChannelNavigationProvider relay={relay}>
              {children}
            </ChannelNavigationProvider>
          )}
        </StrictMode>
      ),
    },
  );
}
it("captures the roster before DM preparation and preserves it across participant changes", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    h.roster(["existing", "new"]);
  });
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "peer"]),
  );
  act(() => view.result.current?.prepareDm(["other"]));
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "other"]),
  );
  act(() => view.result.current?.clearPreparingDm());
  expect(view.result.current.preparingDm).toBeUndefined();
});
it("resets transient handoffs and rejects retired callbacks on session replacement", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "leave",
    );
  });
  const retired = view.result.current;
  retired.activityThread.current = {
    channelId: "channel",
    messageId: "root",
    entryId: "visit",
    signal: new AbortController().signal,
    trigger: null,
  };
  retired.activityAgent.current = {
    channelId: "channel",
    agent: "agent",
    trigger: null,
  };
  act(() => h.replace());
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  expect(view.result.current.activityThread.current).toBeUndefined();
  expect(view.result.current.activityAgent.current).toBeUndefined();
  act(() => {
    retired.prepareDm(["late"]);
    retired.openLifecycle({ id: "late", name: "Late" }, "leave");
  });
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
});

it("hands both entrances to one confirmation and preserves its origin until closed", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const trigger = document.createElement("button");
  act(() => view.result.current.openLifecycle(channel, "leave", trigger));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "leave",
    trigger,
  });
  act(() =>
    view.result.current.openLifecycle({ id: "other", name: "Other" }, "delete"),
  );
  expect(view.result.current.lifecycleDialog?.channel).toBe(channel);
  act(() => view.result.current.closeLifecycle());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() => view.result.current.openLifecycle(channel, "archive"));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});

it("retains the settings tab close control when an archive action remounts", () => {
  const view = mount(fixture().relay);
  const content = (archived: boolean) => (
    <PanelWorkspace
      value="settings"
      select={() => {}}
      items={[
        {
          id: "settings",
          label: "Channel settings",
          close: () => {},
          content: (
            <aside aria-label="Channel settings">
              <button type="button">Canvas</button>
              <button key={String(archived)} type="button">
                {archived ? "Unarchive channel" : "Archive channel"}
              </button>
            </aside>
          ),
        },
      ]}
    />
  );
  const panel = render(content(false));
  const trigger = panel.getByRole("button", { name: "Archive channel" });
  const close = panel.getByRole("button", {
    name: "Close Channel settings tab",
  });
  act(() =>
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "archive",
      trigger,
    ),
  );
  panel.rerender(content(true));
  expect(trigger.isConnected).toBe(false);
  expect(view.result.current.lifecycleDialog?.focusFallback).toBe(close);
  expect(close.isConnected).toBe(true);
});

it("publishes sidebar actions to a sibling menu and retires them with the session", () => {
  const h = fixture();
  const view = renderHook(
    () => ({
      handoff: useChannelNavigation(),
      actions: useChannelMenuActions(),
    }),
    {
      wrapper: ({ children }) => (
        <ChannelNavigationProvider relay={h.relay}>
          {children}
        </ChannelNavigationProvider>
      ),
    },
  );
  const retired = view.result.current.handoff?.menuActions;
  if (!retired) throw new Error("Missing navigation provider");
  const actions = () => ["Mute"];
  act(() => retired.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => h.replace());
  expect(view.result.current.actions).toBeUndefined();
  act(() => retired.publish(() => ["stale"]));
  expect(view.result.current.actions).toBeUndefined();
  act(() => view.result.current.handoff?.menuActions.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => view.result.current.handoff?.menuActions.publish(undefined));
  expect(view.result.current.actions).toBeUndefined();
});

it("retires only the originating header confirmation and rejects its deferred reopening", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const origin = new AbortController();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog?.origin).toBe(origin.signal);
  act(() => origin.abort());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  const old = new AbortController();
  act(() =>
    view.result.current.openLifecycle(channel, "delete", undefined, old.signal),
  );
  act(() => view.result.current.closeLifecycle());
  act(() => view.result.current.openLifecycle(channel, "archive"));
  act(() => old.abort());
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});

it("runs a chat archive's Undo through the lifecycle gate, after any action holding it", async () => {
  const pending = new Map<string, () => void>();
  const run = vi.fn(
    (action: string, id: string) =>
      new Promise<void>((resolve) => pending.set(`${action}:${id}`, resolve)),
  );
  const view = mount(fixture(run).relay, true);
  const planning = { id: "a", name: "Planning", channelType: "solo" as const };
  const roadmap = { id: "b", name: "Roadmap", channelType: "solo" as const };
  act(() => view.result.current.openLifecycle(planning, "archive"));
  await waitFor(() => expect(pending.has("archive:a")).toBe(true));
  await act(async () => pending.get("archive:a")?.());
  await screen.findByRole("dialog", { name: "Chat archived: Planning" });
  expect(view.result.current.lifecycleDialog).toBeUndefined();

  // Another archive holds the session's one lifecycle slot.
  act(() => view.result.current.openLifecycle(roadmap, "archive"));
  await waitFor(() => expect(pending.has("archive:b")).toBe(true));
  const [undo] = screen.getAllByRole("button", { name: "Undo" });
  if (!undo) throw new Error("Missing Undo");
  fireEvent.click(undo);
  expect(run).not.toHaveBeenCalledWith("unarchive", "a", expect.anything());
  expect(view.result.current.lifecycleDialog?.channel).toBe(roadmap);

  await act(async () => pending.get("archive:b")?.());
  // Undo then holds the gate, so lifecycle menus stay disabled until it settles.
  await waitFor(() =>
    expect(run).toHaveBeenLastCalledWith(
      "unarchive",
      "a",
      expect.any(AbortSignal),
    ),
  );
  expect(view.result.current.lifecycleDialog).toMatchObject({
    channel: planning,
    action: "unarchive",
    confirmed: true,
  });
  // A slow Undo is announced instead of leaving the click unanswered.
  expect(
    await screen.findByRole(
      "dialog",
      { name: "Unarchiving chat…" },
      { timeout: 2000 },
    ),
  ).toBeDefined();
  await act(async () => pending.get("unarchive:a")?.());
  await screen.findByRole("dialog", { name: "Chat unarchived: Planning" });
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(3);
});

it("settles a requested confirmation as declined, failed or completed, and retires it with its origin", async () => {
  const outcomes: ("done" | Error)[] = [new Error("Relay refused"), "done"];
  const run = vi.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
  });
  const view = mount(fixture(run).relay, true);
  const planning = {
    id: "a",
    name: "Planning",
    channelType: "stream" as const,
  };
  const origin = new AbortController();
  const ask = () =>
    view.result.current.confirmLifecycle(planning, "archive", origin.signal);
  const dialog = () =>
    screen.findByRole("dialog", { name: "Archive channel: Planning" });

  let answer = ask();
  await dialog();
  await expect(
    act(() =>
      view.result.current.confirmLifecycle(planning, "archive", origin.signal),
    ),
  ).rejects.toThrow("Another channel action is waiting for an answer.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect(answer).resolves.toBe("cancelled");
  expect(run).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(view.result.current.lifecycleDialog).toBeUndefined(),
  );

  answer = ask();
  await dialog();
  fireEvent.click(screen.getByRole("button", { name: "Archive channel" }));
  await expect(answer).rejects.toThrow("Archive channel failed: Relay refused");
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Relay refused")).toBeNull();
  await waitFor(() =>
    expect(view.result.current.lifecycleDialog).toBeUndefined(),
  );

  answer = ask();
  await dialog();
  fireEvent.click(screen.getByRole("button", { name: "Archive channel" }));
  await expect(answer).resolves.toBe("completed");
  expect(run).toHaveBeenCalledTimes(2);
  await screen.findByRole("dialog", { name: "Channel archived: Planning" });

  answer = ask();
  const abandoned = expect(answer).rejects.toMatchObject({
    name: "AbortError",
  });
  await dialog();
  act(() => origin.abort());
  await abandoned;
  await waitFor(() =>
    expect(view.result.current.lifecycleDialog).toBeUndefined(),
  );
  await expect(ask()).rejects.toMatchObject({ name: "AbortError" });
});

it("lets a confirmed archive finish after its origin is gone: it still completes and toasts, and a failure then is shown as a toast", async () => {
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const view = mount(fixture(run).relay, true);
  const planning = {
    id: "a",
    name: "Planning",
    channelType: "stream" as const,
  };
  const confirmed = async () => {
    const origin = new AbortController();
    const answer = view.result.current.confirmLifecycle(
      planning,
      "archive",
      origin.signal,
    );
    const settled = vi.fn();
    answer.then(settled, settled);
    fireEvent.click(
      await screen.findByRole("button", { name: "Archive channel" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalled());
    act(() => origin.abort());
    return { answer, settled };
  };

  const first = await confirmed();
  await act(async () => {});
  expect(first.settled).not.toHaveBeenCalled();
  expect(screen.queryByText("Archive channel failed")).toBeNull();
  await act(async () => pending[0]?.resolve());
  await expect(first.answer).resolves.toBe("completed");
  await screen.findByText("Channel archived: Planning");
  await waitFor(() =>
    expect(view.result.current.lifecycleDialog).toBeUndefined(),
  );

  const second = await confirmed();
  await act(async () => pending[1]?.reject(new Error("Relay refused")));
  expect(await screen.findByText("Relay refused")).toBeTruthy();
  await expect(second.answer).rejects.toMatchObject({ name: "AbortError" });
});

it("settles a confirmation asked through a stale handle while another action holds the dialog, instead of waiting forever", async () => {
  const view = mount(fixture().relay, true);
  const planning = {
    id: "a",
    name: "Planning",
    channelType: "stream" as const,
  };
  const stale = view.result.current;
  act(() =>
    view.result.current.openLifecycle(
      planning,
      "delete",
      undefined,
      undefined,
      {
        close() {},
        completed() {},
      },
    ),
  );
  await screen.findByRole("dialog", { name: "Delete Planning?" });
  expect(stale.lifecycleDialog).toBeUndefined();
  await expect(
    act(() =>
      stale.confirmLifecycle(planning, "archive", new AbortController().signal),
    ),
  ).rejects.toThrow("Another channel action is waiting for an answer.");
  expect(view.result.current.lifecycleDialog?.action).toBe("delete");
});

it.each([
  ["before the user confirms", false],
  ["while the confirmed action runs", true],
] as const)(
  "rejects a pending confirmation when the relay session is replaced %s, and a later one through the old handle",
  async (_label, confirmed) => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    const relay = fixture(run);
    const view = mount(relay.relay, true);
    const planning = {
      id: "a",
      name: "Planning",
      channelType: "stream" as const,
    };
    const stale = view.result.current;
    const answer = view.result.current.confirmLifecycle(
      planning,
      "archive",
      new AbortController().signal,
    );
    const rejected = expect(answer).rejects.toThrow(
      "The connection changed before this finished.",
    );
    await screen.findByRole("dialog", { name: "Archive channel: Planning" });
    if (confirmed) {
      fireEvent.click(screen.getByRole("button", { name: "Archive channel" }));
      await waitFor(() => expect(run).toHaveBeenCalled());
    }
    act(() => relay.replace());
    await rejected;
    await expect(
      act(() =>
        stale.confirmLifecycle(
          planning,
          "archive",
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("The connection changed before this finished.");
  },
);
