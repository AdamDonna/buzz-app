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
  error,
  busy,
  retry,
  openLink,
  focusRef,
}: {
  content: string | undefined;
  loaded: boolean;
  error: string;
  busy: boolean;
  retry(): void;
  openLink(url: string): boolean;
  focusRef: Ref<HTMLElement>;
}) {
  return (
    <article
      ref={focusRef}
      tabIndex={-1}
      data-tab-focus
      aria-label="Saved Canvas"
      className={styles.markdown}
    >
      {!loaded ? (
        error ? (
          <>
            <p role="alert">{error}</p>
            <Button loading={busy} onClick={retry}>
              Retry loading
            </Button>
          </>
        ) : (
          <p role="status">Loading Canvas…</p>
        )
      ) : content ? (
        <CanvasMarkdown content={content} openLink={openLink} />
      ) : (
        <p className="text-secondary">This Canvas is empty.</p>
      )}
    </article>
  );
}
