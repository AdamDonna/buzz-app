import { memo, type Ref } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageLink } from "../../features/conversation/MessageLink";
import { labelText } from "../../features/messages/label-text";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import {
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./Canvas.module.css";

/**
 * Rendering budget for the View tab, independent of what Canvas saves accept.
 * Larger or deeply nested documents show their source instead.
 */
export const CANVAS_RENDER_CHARS = 128 * 1024;

export function renderable(content: string) {
  return (
    content.length <= CANVAS_RENDER_CHARS && !scanMarkdown(content).tooDeep
  );
}

/** The saved Canvas as Markdown, without raw HTML, inline images or unsafe links. */
export const CanvasMarkdown = memo(function CanvasMarkdown({
  content,
  openLink,
}: {
  content: string;
  openLink(url: string): boolean;
}) {
  if (!renderable(content))
    return (
      <>
        <p role="status" className="text-secondary">
          This Canvas is too large or too deeply nested to render, so it is
          shown as Markdown source.
        </p>
        <pre>{content}</pre>
      </>
    );
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        parseBuzzLink(url) ? url : (safeLinkUrl(url) ?? null)
      }
      components={{
        img: ({ alt }) => alt ?? null,
        a: ({ children, href }) => {
          if (!href) return children;
          // A raw autolink shows its destination's name, as in messages.
          const label = labelText(children);
          const raw = label === href;
          return (
            <MessageLink
              url={href}
              label={raw ? undefined : label}
              registry={undefined}
              onOpenLink={openLink}
            >
              {raw ? undefined : children}
            </MessageLink>
          );
        },
      }}
    >
      {content}
    </Markdown>
  );
});

export function CanvasView({
  content,
  loaded,
  readError,
  busy,
  retry,
  openLink,
  focusRef,
  retryRef,
  active,
}: {
  content: string | undefined;
  loaded: boolean;
  /** The latest read's failure; kept, with its Retry, until a read succeeds. */
  readError: string;
  busy: boolean;
  retry(): void;
  openLink(url: string): boolean;
  focusRef: Ref<HTMLElement>;
  retryRef: Ref<HTMLButtonElement>;
  /** Only the active tab offers the panel host a focus target. */
  active: boolean;
}) {
  return (
    <LoadingRegion
      pending={!loaded && !readError}
      label="Loading Canvas…"
      feedback={
        readError ? (
          <div className={styles.failure}>
            <p role="alert">{readError}</p>
            <Button ref={retryRef} loading={busy} onClick={retry}>
              Retry loading
            </Button>
          </div>
        ) : undefined
      }
    >
      <article
        ref={focusRef}
        tabIndex={-1}
        data-tab-focus={active || undefined}
        aria-label="Saved Canvas"
        className={styles.markdown}
      >
        {!loaded ? null : content ? (
          <CanvasMarkdown content={content} openLink={openLink} />
        ) : (
          <p className="text-secondary">This Canvas is empty.</p>
        )}
      </article>
    </LoadingRegion>
  );
}
