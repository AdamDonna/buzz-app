import { expect, it } from "vitest";
import type { ComposerSession } from "../../features/messages/composer-session";
import {
  bindNames,
  type NameSource,
} from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { namedCandidates } from "./use-mention-choices";

const key = (n: number) => n.toString(16).padStart(64, "0");

it.each([
  ["no naming policy", undefined],
  ["the default naming policy", [createAgentDirectory()]],
])(
  "labels a person with the verified name the mention will insert, with %s",
  (_, policies) => {
    // Their kind-0 profile is cached; the community verified them as fname.
    const profiles = new Map([[key(8), { name: "fak" }]]);
    const names = bindNames(
      {
        profiles: {
          snapshot: () => profiles,
          subscribe: () => () => {},
        },
        agentLibrary: {
          snapshot: () => ({
            status: "ready",
            definitions: [],
            identities: [],
          }),
          subscribe: () => () => {},
          refresh: async () => {},
          retain: () => () => {},
        },
      } as unknown as NameSource,
      policies && { snapshot: () => policies, subscribe: () => () => {} },
    );
    const session = {
      viewer: key(1),
      names,
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            { id: "c", name: "C", channelType: "stream", members: [key(1)] },
          ],
        }),
      },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      profiles: { snapshot: () => profiles },
      archives: { snapshot: () => ({ status: "ready", archived: [] }) },
      outbox: { supports: () => true },
    } as unknown as ComposerSession;
    const choices = namedCandidates(
      session,
      "c",
      false,
      undefined,
      [],
      [
        {
          pubkey: key(8),
          name: "fname",
          fullName: "Fake Name",
          profileNames: ["fak"],
        },
      ],
    );
    const fake = choices.find((choice) => choice.recipient.pubkey === key(8));
    expect(fake).toMatchObject({
      label: "fname",
      recipient: { name: "fname" },
      fullName: "Fake Name",
    });
    names.dispose();
  },
);
