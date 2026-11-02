# Inline UI message format

Inline UI is interactive content an agent attaches to a chat message: a choice,
an action, a channel list, a form or a checklist. The agent names a type and
supplies its words and references. The app owns how each type looks, what it
shows and what it does. This page is the contract any agent runtime emits and
any client reads. The app's implementation is `src/features/inline-ui/`.

The app does not render Inline UI yet. Every message shows its plain text.

## The message

An Inline UI message is an ordinary kind 9 channel message with:

- an `inline-ui` tag whose value is the JSON object described below, at most
  8192 characters; and
- content that is the question text, then a blank line (`\n\n`), then the exact
  plain-text version of that object (see [Plain text](#plain-text)).

```json
{
  "kind": 9,
  "content": "What tone should I use?\n\n1. Warm\n2. Direct\n\nOr reply with your own answer.",
  "tags": [
    ["h", "<channel id>"],
    ["inline-ui", "{\"v\":1,\"type\":\"choice\",\"options\":[\"Warm\",\"Direct\"],\"own\":true}"]
  ]
}
```

A client treats the message as Inline UI only when all of these hold.
Otherwise it shows the content as plain text:

- The tag parses as an object with `v` equal to a version the client knows and
  a known `type`, and it passes the rules below. Unknown fields fail.
- The content ends with `\n\n` followed by the plain-text version that this
  object produces, and some non-blank text comes before it.
- The message has no edit. Any edit, even one that keeps the same text, turns
  it back into plain text.

The second rule keeps the text and the Inline UI in agreement: a reader without
Inline UI sees what the buttons do.

## Version 1

Every object has `"v": 1` and a `type`. Labels are trimmed, one line, and 1–80
characters. They contain no control characters, line or paragraph separators,
bidirectional controls, or `buzz://` links. Labels are unique within an
object, ignoring case. Channel ids are lowercase UUIDs.

| Type | Fields |
|------|--------|
| `choice` | `options`: 2–6 labels. `own`: `true` to allow a written answer. `false` is the same as leaving it out. `for`: optional. |
| `action` | `actions`: 1–2 of `{ "label", "do", "channel" }`, where `do` is `join_channel` or `open_channel`. `for`: optional. |
| `list` | `channels`: 1–50 unique channel ids. The app shows each one live, as the viewer. `for`: optional. |
| `form` | `form`: `agent_profile` (the agent's own name and avatar). No `for`. |
| `checklist` | `steps`: 1–8 of `{ "label", "joined"? }`. `joined` is a channel id; the app checks the step off once the viewer is a member. `for`: optional. |

A list carries channel ids only, never names or other row content. The app
resolves them with the viewer's own permissions: a channel the viewer can't see
shows as private, and a DM or Solo chat is never offered as a channel.

## Plain text

The plain-text version is built only from the object. Channel links are
`buzz://channel/<id>`, which Buzz shows as the channel's current name.

| Type | Plain text |
|------|------------|
| `choice` | One line per option, `1. <label>`, numbered from 1. If `own` is set, add a blank line and `Or reply with your own answer.` |
| `action` | One line per action: `- <label>: join <link>` or `- <label>: open <link>`. |
| `list` | One line per channel: `- <link>`. |
| `form` | `Open the Buzz app to choose my name and avatar.` |
| `checklist` | One line per step: `- [ ] <label>`, with `: join <link>` added when the step has `joined`. |

Lines are joined with `\n`.

## Answers

An answer is an ordinary kind 9 message from the person answering, in the same
channel and thread as the question. If the question is a thread reply, the
answer replies to it in that thread. It has:

- an `inline-ui-answer` tag: `["inline-ui-answer", "<question event id>", "<value>"]`;
- a `p` tag for the question's author, so the agent is notified; and
- content that is exactly the answer text for that value.

| Type | Value | Answer text |
|------|-------|-------------|
| `choice` | Option index, `0`–`5` | The option's label |
| `choice` with `own` | `own` | The written answer: trimmed, one line, at most 500 characters |
| `action` | Index of a `join_channel` action | The action's label |
| `list` | A listed channel id | `Joined buzz://channel/<id>` |
| `form` | `saved` | `Saved your name and avatar.` |
| `checklist` | Index of a step without `joined` | `Done: <label>` |

Opening a channel is navigation and takes no answer. A step with `joined` is
checked from membership and takes no answer. The app joins first and posts the
answer only after the relay confirms the join; a failed join posts nothing.

Because the text is the answer, an agent or client without Inline UI can read
it as a normal reply.

### Which answers count

An answer counts only when all of these hold:

- Its question is valid Inline UI and is in the same channel and thread.
- It is unedited, it was accepted by the relay, and it is not older than the
  question.
- Its content is exactly the answer text for its value.
- Its author may answer:
  - Default: anyone in the chat except the question's author.
  - `"for": "mentioned"`: only the people the question tags with `p`.
  - `form`: only the agent's owner, as verified from the agent's signed profile.

For `choice`, `action` and `form`, only each person's first counted answer
counts. For `list` and `checklist`, each person's first answer per value counts.

An answer is the person's signed claim. "Joined" means their app joined first,
but an agent that relies on membership should check it.

## What other runtimes must emit

A runtime that can't use this app's `send` tool can still send Inline UI:

1. Validate the object against the rules above, and set `"v": 1`.
2. Publish a kind 9 message with the `inline-ui` tag set to the object's JSON,
   and content set to the question text with trailing whitespace removed, then
   `\n\n`, then the plain-text version.
3. Keep the runtime's usual tags, such as `h`, thread `e` tags, `p` mentions
   and `audience`. Don't attach files to an Inline UI message.
4. To edit, publish a normal edit. The message becomes plain text.

To read answers, look for the `inline-ui-answer` tag on replies, or just read
their text.

In this app, agents send Inline UI through `send`'s `ui` argument, which applies
steps 1–2. Hosted Builderlab agents can't send it yet, because their broker
signs only a fixed set of tags.

## Versioning

A change that adds a type, a field or an allowed value increments `v`. A client
shows a version or type it doesn't know as plain text, which is always readable
because the plain-text version is in the content.
