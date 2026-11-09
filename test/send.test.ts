import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JmapClient } from "../src/core/jmap.js";
import { registerTools } from "../src/core/tools.js";

const SELF = "me@example.eu";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Status = Record<string, { delivered: string; smtpReply: string }>;

/**
 * A fake JMAP server that answers the calls a send makes, the way Stalwart
 * does: EmailSubmission/set reports `created` even when every RCPT TO was
 * refused, and the refusals only show in the submission's deliveryStatus.
 */
function fakeServer(deliveryStatus: Status, undoStatus = "final") {
  const calls: any[][] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    if (String(url).endsWith("/jmap/session")) {
      return Response.json({
        apiUrl: "https://mail.test/jmap/",
        downloadUrl: "",
        uploadUrl: "",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" },
        capabilities: {},
      });
    }
    const { methodCalls } = JSON.parse(init.body);
    const methodResponses = methodCalls.flatMap((c: any[]) => {
      calls.push(c);
      const [name, args, tag] = c;
      switch (name) {
        case "Mailbox/get":
          return [[name, { list: [{ id: "mbD", role: "drafts", name: "Drafts" }, { id: "mbS", role: "sent", name: "Sent" }] }, tag]];
        case "Identity/get":
          return [[name, { list: [{ id: "i1", email: SELF }] }, tag]];
        case "Email/get":
          return [[name, { list: [{ id: args.ids[0], from: [{ email: SELF }], to: [{ email: "nobody@example.eu" }], keywords: { $draft: true }, mailboxIds: { mbD: true } }] }, tag]];
        case "Email/set":
          return [[name, { created: args.create ? { draft: { id: "e1" } } : undefined, updated: args.update, destroyed: args.destroy }, tag]];
        case "EmailSubmission/set":
          // Stalwart runs onSuccessUpdateEmail as an implicit Email/set right after.
          return [[name, { created: { sub: { id: "s1", undoStatus } } }, tag], ["Email/set", { updated: { e1: null } }, tag]];
        case "EmailSubmission/get":
          return [[name, { list: [{ id: "s1", undoStatus, deliveryStatus }] }, tag]];
        default:
          throw new Error(`unexpected ${name}`);
      }
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  return calls;
}

const refused = { delivered: "no", smtpReply: "550 5.1.2 Mailbox does not exist." };
const queued = { delivered: "unknown", smtpReply: "250 2.1.5 Queued" };
const msg = { to: ["nobody@example.eu"], subject: "Hi", body: "x", format: "plain" as const, signature: false };

test("send fails when the server refuses every recipient", async () => {
  const calls = fakeServer({ "nobody@example.eu": refused, "postmaster@example.eu": refused });
  const c = new JmapClient("https://mail.test", SELF, "pw");
  await assert.rejects(
    c.send({ ...msg, cc: ["postmaster@example.eu"] }),
    (e: Error) =>
      /not sent/i.test(e.message) &&
      e.message.includes("nobody@example.eu: 550 5.1.2 Mailbox does not exist") &&
      e.message.includes("postmaster@example.eu"),
  );
  // The undelivered copy does not stay in Sent.
  assert.ok(calls.some(([name, args]) => name === "Email/set" && args.destroy?.includes("e1")));
});

test("send reports which recipients were refused when others got it", async () => {
  fakeServer({ "ok@example.eu": queued, "Nobody@Example.eu": refused });
  const c = new JmapClient("https://mail.test", SELF, "pw");
  const r = await c.send({ ...msg, to: ["ok@example.eu", "nobody@example.eu"] });
  assert.deepEqual(r.accepted, ["ok@example.eu"]);
  assert.deepEqual(r.rejected, [{ email: "nobody@example.eu", reason: "550 5.1.2 Mailbox does not exist." }]);
});

test("send succeeds when every recipient is accepted", async () => {
  fakeServer({ "nobody@example.eu": queued }, "pending");
  const c = new JmapClient("https://mail.test", SELF, "pw");
  const r = await c.send(msg);
  assert.deepEqual(r, { id: "s1", accepted: ["nobody@example.eu"], rejected: [] });
});

test("send_draft fails on full refusal and puts the draft back", async () => {
  const calls = fakeServer({ "nobody@example.eu": refused });
  const c = new JmapClient("https://mail.test", SELF, "pw");
  await assert.rejects(c.sendDraft("d1"), /not sent.*Drafts/is);
  const restore = calls.find(([name, args]) => name === "Email/set" && args.update?.d1);
  assert.deepEqual(restore?.[1].update.d1, { mailboxIds: { mbD: true }, "keywords/$draft": true });
});

/** Registers the tools on a stub server and returns a caller for them. */
function toolRunner(beforeSend?: () => Promise<void>) {
  const handlers = new Map<string, (a: any) => Promise<any>>();
  registerTools(
    { tool: (name: string, _d: string, _s: unknown, _h: unknown, run: (a: any) => Promise<any>) => void handlers.set(name, run) },
    { client: () => new JmapClient("https://mail.test", SELF, "pw"), canSend: () => true, beforeSend },
  );
  return (name: string, args: any) => handlers.get(name)!(args);
}

const isSend = ([name]: any[]) => name === "EmailSubmission/set";

test("beforeSend throwing stops send_email and its message reaches the result", async () => {
  const calls = fakeServer({ "nobody@example.eu": queued }, "pending");
  const run = toolRunner(async () => {
    throw new Error("Monthly limit reached.");
  });
  const r = await run("send_email", { to: ["nobody@example.eu"], subject: "Hi", body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Monthly limit reached\./);
  assert.ok(!calls.some(isSend));
});

test("beforeSend throwing stops reply_email and send_draft", async () => {
  const calls = fakeServer({ "nobody@example.eu": queued }, "pending");
  const run = toolRunner(async () => {
    throw new Error("Not on this plan.");
  });
  for (const [name, args] of [["reply_email", { id: "m1", body: "x" }], ["send_draft", { id: "d1" }]] as const) {
    const r = await run(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /Not on this plan\./, name);
  }
  assert.ok(!calls.some(isSend));
});

test("beforeSend that resolves lets the send through, once", async () => {
  const calls = fakeServer({ "nobody@example.eu": queued }, "pending");
  let n = 0;
  const run = toolRunner(async () => void n++);
  const r = await run("send_email", { to: ["nobody@example.eu"], subject: "Hi", body: "x" });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(n, 1);
  assert.ok(calls.some(isSend));
});
