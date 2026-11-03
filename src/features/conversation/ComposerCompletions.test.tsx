// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ComposerCompletions } from "./ComposerCompletions";
import type { CompletionEditor } from "./useCompletionEditor";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  ComposerToolProps,
  CompletionContext,
} from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import type { RelaySession } from "../relay/session";
import type { ComposerInputElement } from "../messages/composer-dom";
import type { ComposerSnapshot } from "../messages/mention-draft";
import { channelQuery } from "../../bundled/channels/channel-query";
import * as markdown from "../relay/message-content";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const providers: Contribution<ComposerCompletion>[] = [
  {
    id: "channel-typeahead",
    key: "buzz.channels/channel-typeahead",
    pluginId: "buzz.channels",
    revision: "1",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: () => <span>Channel provider mounted</span>,
  },
];
function mount(text: string, caret = text.length, document?: ComposerSnapshot) {
  const editor = {
    observation: { revision: 1, text, start: caret, end: caret },
    valid: () => true,
    observe: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
    composerSignal: undefined,
  } as CompletionEditor;
  return render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: null as ComposerInputElement | null }}
      replace={() => true}
      resolved={{ text, recipients: [], ...(document ? { document } : {}) }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
}
it.each(["#", "prose #we", "## Heading #we", "> #we", "- #we"])(
  "allows prose: %s",
  (text) => {
    mount(text);
    expect(screen.queryByText("Channel provider mounted")).not.toBeNull();
  },
);
it.each([
  ["`code #we`", 9],
  ["```\n#we\n```", 7],
  ["    #we", 7],
  ["[label #we](https://example.test)", 10],
  ["![alt #we](https://example.test)", 9],
  ["[label #we][ref]\n\n[ref]: https://example.test", 10],
  ["<span>\n#we\n</span>", 10],
  ["[ref]: https://example.test (#we)", 30],
] as const)("does not mount inside raw code/links/HTML: %s", (text, caret) => {
  mount(text, caret);
  expect(screen.queryByText("Channel provider mounted")).toBeNull();
});
it.each(["code", "link", "literal"])(
  "does not mount in rich %s marks",
  (mark) => {
    mount("#we", 3, {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "#we",
                marks: [
                  {
                    type: mark,
                    ...(mark === "link"
                      ? { attrs: { href: "https://example.test" } }
                      : {}),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(screen.queryByText("Channel provider mounted")).toBeNull();
  },
);
it("does no additional Markdown parsing on ordinary typing", () => {
  const scan = vi.spyOn(markdown, "scanMarkdown");
  mount("An ordinary message without a channel trigger");
  expect(scan).not.toHaveBeenCalled();
});

it.each(["replace", "remove", "unknown"])(
  "retires recipient-scoped query closures on %s without changing text, caret or composer lifetime",
  (change) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const previous = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    HTMLElement.prototype.scrollIntoView = vi.fn();
    onTestFinished(() => {
      if (previous)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          previous,
        );
      else
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });
    const selected = [{ pubkey: "a".repeat(64), name: "Same label" }];
    const next =
      change === "replace"
        ? [{ pubkey: "b".repeat(64), name: "Same label" }]
        : change === "remove"
          ? []
          : undefined;
    const matched: CompletionContext[] = [];
    const requests: ComposerCompletionProps[] = [];
    function Provider(props: ComposerCompletionProps) {
      useLayoutEffect(() => {
        requests.push(props);
      });
      return null;
    }
    const provider: Contribution<ComposerCompletion> = {
      id: "skills",
      key: "test/skills",
      pluginId: "test",
      revision: "1",
      title: "Skills",
      match: (_observation, context) => {
        matched.push(context);
        return { start: 0, end: 1, query: "" };
      },
      component: Provider,
    };
    const entries = [provider];
    const registry = { snapshot: () => entries, subscribe: () => () => {} };
    const input = createRef<HTMLTextAreaElement>();
    const lifetime = new AbortController();
    const editor: CompletionEditor = {
      observation: { revision: 1, text: "/", start: 1, end: 1 },
      valid: () => true,
      observe: () => {},
      invalidate: vi.fn(),
      keys: { current: undefined },
      composing: { current: false },
      composerSignal: lifetime.signal,
    };
    const replace = vi.fn(() => true);
    const retry = vi.fn();
    const tree = (recipients: ComposerToolProps["recipients"] | undefined) => (
      <>
        <textarea ref={input} defaultValue="/" />
        <ComposerCompletions
          registry={registry}
          editor={editor}
          input={input as unknown as { current: ComposerInputElement | null }}
          replace={replace}
          resolved={{ text: "/", recipients: [] }}
          session={{} as RelaySession}
          scope="test"
          channelId="channel"
          {...(recipients === undefined ? {} : { recipients })}
        />
      </>
    );
    const view = render(tree(selected));
    const old = requests.at(-1);
    if (!old) throw new Error("Completion provider did not mount");
    expect(old.recipients).toBe(selected);
    expect(matched.at(-1)?.recipients).toBe(selected);
    let release: ReturnType<ComposerCompletionProps["publish"]> = false;
    act(() => {
      release = old.publish({
        items: [{ id: "old", label: "Old skill", edit: { text: "old" } }],
        retry,
      });
    });
    const oldChoice = screen.getByRole("option", { name: "Old skill" });
    const oldRetry = screen.getByRole("option", { name: "Retry suggestions" });
    const oldChoiceKeys = editor.keys.current;
    const key = (key: string) =>
      ({
        key,
        nativeEvent: {},
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as Parameters<
        NonNullable<CompletionEditor["keys"]["current"]>
      >[0];
    act(() => {
      editor.keys.current?.(key("ArrowUp"));
    });
    const oldKeys = editor.keys.current;
    view.rerender(tree(next));
    const fresh = requests.at(-1);
    if (!fresh) throw new Error("Updated completion provider did not mount");
    expect(fresh).not.toBe(old);
    expect(fresh.recipients).toBe(next);
    expect(matched.at(-1)?.recipients).toBe(next);
    expect(fresh.composerSignal).toBe(lifetime.signal);
    expect(lifetime.signal.aborted).toBe(false);
    expect(oldChoice.isConnected).toBe(false);
    expect(oldRetry.isConnected).toBe(false);
    act(() => {
      expect(
        old.publish({
          items: [{ id: "late", label: "Late", edit: { text: "late" } }],
        }),
      ).toBe(false);
      oldChoiceKeys?.(key("Enter"));
      oldKeys?.(key("Enter"));
      fireEvent.click(oldChoice);
      fireEvent.click(oldRetry);
      fresh.publish({
        items: [{ id: "fresh", label: "Fresh skill", edit: { text: "fresh" } }],
      });
      if (typeof release === "function") release();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Fresh skill" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Late" })).toBeNull();
  },
);
