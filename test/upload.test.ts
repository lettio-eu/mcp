import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JmapClient } from "../src/core/jmap.js";
import { registerTools, type ToolContext } from "../src/core/tools.js";

const SELF = "me@example.eu";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A JMAP server that takes one blob upload and one draft. */
function fakeServer() {
  const seen = { uploads: [] as { type: string; bytes: number[] }[], draft: null as any };
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith("/jmap/session")) {
      return Response.json({
        apiUrl: "https://mail.test/jmap/",
        downloadUrl: "",
        uploadUrl: "https://mail.test/upload/{accountId}/",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" },
        capabilities: { "urn:ietf:params:jmap:core": { maxSizeUpload: 1000 } },
      });
    }
    if (u.startsWith("https://mail.test/upload/")) {
      seen.uploads.push({ type: init.headers["Content-Type"], bytes: [...(init.body as Uint8Array)] });
      return Response.json({ blobId: "blob1" });
    }
    const { methodCalls } = JSON.parse(init.body);
    const methodResponses = methodCalls.map(([name, args, tag]: any[]) => {
      if (name === "Mailbox/get") return [name, { list: [{ id: "mbD", role: "drafts", name: "Drafts" }] }, tag];
      if (name === "Identity/get") return [name, { list: [{ id: "i1", email: SELF }] }, tag];
      if (name === "Email/set") {
        seen.draft = Object.values(args.create)[0];
        return [name, { created: { draft: { id: "e1" } } }, tag];
      }
      throw new Error(`unexpected ${name}`);
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  return seen;
}

function toolRunner(uploads: ToolContext["uploads"]) {
  const handlers = new Map<string, (a: any) => Promise<any>>();
  registerTools(
    { tool: (name: string, _d: string, _s: unknown, _h: unknown, run: (a: any) => Promise<any>) => void handlers.set(name, run) },
    { client: () => new JmapClient("https://mail.test", SELF, "pw"), canSend: () => true, uploads },
  );
  return { has: (n: string) => handlers.has(n), run: (name: string, args: any) => handlers.get(name)!(args) };
}

const store = () => {
  const files = new Map<string, { owner: string; name: string; type: string; bytes: Uint8Array }>();
  files.set("u1", { owner: SELF, name: "invoice.pdf", type: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
  const uploads: NonNullable<ToolContext["uploads"]> = {
    async prepare(owner, name) {
      return { id: `new-${owner}-${name}`, url: "https://mcp.test/upload/x", expiresAt: "2026-01-01T00:15:00Z", maxBytes: 1000 };
    },
    async take(owner, id) {
      const f = files.get(id);
      if (!f || f.owner !== owner) throw new Error("Unknown or expired upload.");
      return f;
    },
  };
  return uploads;
};

test("prepare_upload exists only when the server offers uploads", () => {
  assert.equal(toolRunner(undefined).has("prepare_upload"), false);
  assert.equal(toolRunner(store()).has("prepare_upload"), true);
});

test("prepare_upload binds the ticket to the mailbox and returns a curl command", async () => {
  const r = await toolRunner(store()).run("prepare_upload", { name: "invoice.pdf" });
  const t = r.content[0].text;
  assert.match(t, /upload_id: new-me@example\.eu-invoice\.pdf/);
  assert.match(t, /curl -sS --fail-with-body -T '<local file>' 'https:\/\/mcp\.test\/upload\/x'/);
});

test("create_draft attaches an uploaded file by upload_id", async () => {
  const seen = fakeServer();
  const r = await toolRunner(store()).run("create_draft", {
    to: ["a@example.eu"], subject: "Invoice", body: "x", format: "plain", signature: false,
    attachments: [{ upload_id: "u1" }],
  });
  assert.doesNotMatch(r.content[0].text, /^Error/);
  assert.deepEqual(seen.uploads, [{ type: "application/pdf", bytes: [37, 80, 68, 70] }]);
  assert.deepEqual(seen.draft.attachments, [{ blobId: "blob1", type: "application/pdf", name: "invoice.pdf", disposition: "attachment" }]);
});

test("an upload_id from another mailbox is refused", async () => {
  fakeServer();
  const uploads = store();
  const r = await toolRunner({ ...uploads, take: (_o, id) => uploads.take("other@example.eu", id) }).run("create_draft", {
    to: ["a@example.eu"], subject: "x", body: "x", format: "plain", signature: false, attachments: [{ upload_id: "u1" }],
  });
  assert.match(r.content[0].text, /Error: Unknown or expired upload/);
});
