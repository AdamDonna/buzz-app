import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { federatedFixture } from "../federated-identity/testing";
import { createFederatedFirstRun } from "./federated-first-run";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {},
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const response = (body: unknown) => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

it.each([null, "ab".repeat(32)])(
  "reads first-run account binding %s through the native grant without a token",
  async (key) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    const h = federatedFixture();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "federated_identity_request") {
        const path =
          (args as { request?: { path?: string } } | undefined)?.request
            ?.path ?? "";
        if (path.endsWith("auth/me"))
          return response({ subject: "account", email: "a@example.com" });
        if (path.endsWith("nostr-identities/current"))
          return response({ identity: key ? { pubkey_hex: key } : null });
        throw new Error(`Unexpected route ${path}`);
      }
      if (
        command === "federated_identity_register" ||
        command === "federated_identity_unregister"
      )
        return;
      throw new Error(`Unexpected native operation ${command}`);
    });
    const session = createFederatedFirstRun(h.service);
    try {
      await session.ensureSignedIn(new AbortController().signal);
      const reply = await session.request(session.credential(), {
        path: "/v1/buzz/nostr-identities/current",
        method: "POST",
        headers: { Origin: "https://builderlab.example" },
      });
      expect(JSON.parse(reply.body).identity?.pubkey_hex ?? null).toBe(key);
      const requests = vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "federated_identity_request",
        );
      expect(requests).toHaveLength(2);
      expect(requests[1]?.[1]).toMatchObject({
        id: "block.builderlab",
        revision: "bundled",
        session: "user:1",
        request: {
          path: "/api/goose/v1/buzz/nostr-identities/current",
          headers: { Origin: "https://builderlab.example" },
        },
      });
      expect(JSON.stringify(requests)).not.toMatch(
        /Authorization|X-BB-Session-Credential/,
      );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([command]) => command === "federated_identity_unregister",
          ),
      ).toHaveLength(2);
      expect(h.service.request).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  },
);

it("refuses first-run account setup without a bundled authority grant and releases the registration", async () => {
  const h = federatedFixture();
  vi.mocked(invoke)
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(
      new Error("Plugin has no authenticated authority grant"),
    );
  const session = createFederatedFirstRun(h.service);
  try {
    await expect(
      session.ensureSignedIn(new AbortController().signal),
    ).rejects.toThrow("Could not load your Builderlab account");
    expect(h.service.signIn).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "federated_identity_register",
      "federated_identity_unregister",
    ]);
  } finally {
    session.dispose();
  }
});

it("rejects account requests from a retired session before dispatch", async () => {
  const h = federatedFixture();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "federated_identity_request"
      ? response({ subject: "account" })
      : undefined,
  );
  const session = createFederatedFirstRun(h.service);
  try {
    await session.ensureSignedIn(new AbortController().signal);
    const credential = session.credential();
    h.publish({ status: "signed-out", revision: "retired" });
    const before = vi.mocked(invoke).mock.calls.length;
    await expect(
      session.request(credential, {
        path: "/v1/buzz/nostr-identities/challenge",
      }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(before);
  } finally {
    session.dispose();
  }
});

it.each(["once", "always", "network"])(
  "handles registration failure %s without unbounded or arbitrary replay",
  async (mode) => {
    const h = federatedFixture();
    let attempts = 0;
    const revisions: unknown[] = [];
    const registrations: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "federated_identity_register")
        registrations.push(
          (args as Record<string, unknown> | undefined)?.registration,
        );
      if (command !== "federated_identity_request") return;
      const input = args as { session: string; request: { path: string } };
      if (input.request.path.endsWith("auth/me"))
        return response({ subject: "account" });
      revisions.push(input.session);
      attempts++;
      if (mode === "network") return Promise.reject("Network unavailable");
      if (mode === "always" || attempts === 1)
        return Promise.reject("Plugin registration retired");
      return response({ identity: null });
    });
    const session = createFederatedFirstRun(h.service);
    try {
      await session.ensureSignedIn(new AbortController().signal);
      const request = session.request(session.credential(), {
        path: "/v1/buzz/nostr-identities/current",
      });
      if (mode === "once")
        await expect(request).resolves.toMatchObject({ status: 200 });
      else await expect(request).rejects.toThrow();
      expect(attempts).toBe(mode === "network" ? 1 : 2);
      expect(new Set(registrations).size).toBe(registrations.length);
      expect(revisions).toEqual(Array(attempts).fill("user:1"));
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([command]) => command === "federated_identity_unregister",
          ),
      ).toHaveLength(registrations.length);
    } finally {
      session.dispose();
    }
  },
);

it("does not dispatch after disposal while native registration is pending", async () => {
  const h = federatedFixture();
  let hold = false;
  let registered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    registered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "federated_identity_register" && hold) {
      registered();
      await gate;
    }
    if (command === "federated_identity_request")
      return response({ subject: "account" });
  });
  const session = createFederatedFirstRun(h.service);
  await session.ensureSignedIn(new AbortController().signal);
  hold = true;
  const request = session.request(session.credential(), {
    path: "/v1/buzz/nostr-identities/challenge",
  });
  await started;
  session.dispose();
  release();
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_request",
      ),
  ).toHaveLength(1);
});
