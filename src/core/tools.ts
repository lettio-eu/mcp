/**
 * The Lettio MCP tools, shared by the local and hosted servers.
 * Each server supplies a ToolContext; everything else lives here.
 */

import { z } from "zod";
import { base64ToBytes, bytesToBase64, textSignatureToHtml } from "./format.js";
import { notDelivered } from "./jmap.js";
import type { Attachment, BodyFormat, EmailFull, EmailSummary, JmapClient, OutgoingAttachment } from "./jmap.js";
export type { Tagged };

/** Largest attachment returned inline to a model. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;

export type ToolContext = {
  /** Resolve the client for a call. Multi-account servers use the account name. */
  client(account?: string): JmapClient;
  /** Whether this connection may send. Drafts are always allowed. */
  canSend(): boolean;
  /** Added to the refusal when sending is off, e.g. how the user can send it themselves. */
  sendHint?: string;
  /** Set on servers with several mailboxes: adds an `account` parameter. */
  accounts?: () => Array<{ name: string; address: string }>;
  /** Local server only: read a file to attach. */
  readFile?: (path: string) => Promise<{ name: string; bytes: Uint8Array; type?: string }>;
  /** Local server only: save an attachment to disk. */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
};

type McpServerLike = { tool: (...args: any[]) => unknown };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tagged = EmailSummary & { account?: string };

function fmtSummary(e: Tagged, i: number): string {
  const marks = [e.unread ? "unread" : "", e.flagged ? "flagged" : "", e.hasAttachment ? "attachment" : "", ...e.labels]
    .filter(Boolean)
    .join(", ");
  const when = e.receivedAt ? new Date(e.receivedAt).toLocaleString() : "";
  return `${i + 1}. [${e.id}]${marks ? ` (${marks})` : ""}${e.account ? `\n   Mailbox: ${e.account}` : ""}\n   From: ${e.from}\n   ${when} — ${e.subject}\n   ${e.preview}`;
}

function fmtList(title: string, emails: Tagged[]): string {
  if (!emails.length) return `No messages found in ${title}.`;
  return `${title} — ${emails.length} message(s):\n\n${emails.map(fmtSummary).join("\n\n")}`;
}

function fmtAttachments(list: Attachment[]): string {
  if (!list.length) return "";
  const lines = list.map(
    (a) => `- ${a.name} (${a.type}, ${size(a.size)})${a.inline ? " inline" : ""} — attachment_id: ${a.id}`,
  );
  return `\nAttachments:\n${lines.join("\n")}\n`;
}

function fmtEmail(e: EmailFull): string {
  return (
    `Id: ${e.id}\nThread: ${e.threadId}\nFrom: ${e.from}\nTo: ${e.to}\n` +
    (e.cc ? `Cc: ${e.cc}\n` : "") +
    `Date: ${e.receivedAt}\nSubject: ${e.subject}\n` +
    (e.labels.length ? `Labels: ${e.labels.join(", ")}\n` : "") +
    fmtAttachments(e.attachments) +
    `\n${e.body}` +
    (e.truncated ? "\n\n[Message truncated.]" : "")
  );
}

function isTextType(type: string, name: string): boolean {
  return (
    type.startsWith("text/") ||
    /\/(json|xml|csv|yaml|x-yaml|javascript)$/.test(type) ||
    /\.(txt|md|csv|json|xml|ya?ml|log|ics|vcf)$/i.test(name)
  );
}

async function pdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes.slice());
    const { text: pages } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(pages) ? pages.join("\n\n") : pages).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function registerTools(server: McpServerLike, ctx: ToolContext): void {
  const account = ctx.accounts
    ? {
        account: z
          .string()
          .optional()
          .describe("Which mailbox to use. Defaults to the first. Pass the Mailbox shown in a list result when acting on that email."),
      }
    : {};

  /** Several mailboxes and none chosen: run on each and merge newest first. */
  const many = (a: any) => !!ctx.accounts && !a.account && ctx.accounts().length > 1;
  async function across(a: any, run: (c: JmapClient) => Promise<EmailSummary[]>): Promise<Tagged[]> {
    if (!many(a)) return run(ctx.client(a.account));
    const per = await Promise.all(
      ctx.accounts!().map(async (acc) => (await run(ctx.client(acc.name))).map((e) => ({ ...e, account: acc.name }))),
    );
    return per.flat().sort((x, y) => (y.receivedAt || "").localeCompare(x.receivedAt || ""));
  }
  const ids = {
    ids: z.array(z.string()).min(1).max(100).describe("One or more email ids."),
    ...account,
  };
  const attachments = {
    attachments: z
      .array(
        z.object({
          name: z.string().optional().describe("File name, e.g. invoice.pdf."),
          type: z.string().optional().describe("MIME type, e.g. application/pdf."),
          content_base64: z.string().optional().describe("File content, base64 encoded."),
          ...(ctx.readFile ? { path: z.string().optional().describe("Path of a local file to attach.") } : {}),
          from_email_id: z.string().optional().describe("Reuse an attachment from this email (with attachment_id)."),
          attachment_id: z.string().optional().describe("The attachment_id shown by read_email."),
        }),
      )
      .optional()
      .describe("Files to attach. Give content_base64, or from_email_id with attachment_id."),
  };
  const compose = {
    body: z
      .string()
      .describe(
        "The message in Markdown. Supports headings, bold, lists, tables, `> quote` (end with `> — Name` for attribution), " +
          "callouts `> [!NOTE] Title`, code blocks, and buttons `[Label](https://url \"button\")`. Numbered lists render as steps.",
      ),
    format: z.enum(["markdown", "plain"]).optional().describe('"plain" sends text as written, without formatting.'),
    signature: z.boolean().optional().describe("Append the mailbox signature. Default true; don't write a sign-off block yourself."),
    ...attachments,
  };
  const message = {
    to: z.array(z.string()).min(1).describe("Recipient email addresses."),
    cc: z.array(z.string()).optional().describe("Cc recipients."),
    bcc: z.array(z.string()).optional().describe("Bcc recipients."),
    subject: z.string().describe("Subject line."),
    ...compose,
    ...account,
  };
  const reply = {
    id: z.string().describe("The id of the email to reply to."),
    reply_all: z.boolean().optional().describe("Also Cc everyone on the original."),
    ...compose,
    ...account,
  };

  const requireSend = () => {
    if (!ctx.canSend()) {
      throw new Error(
        ctx.sendHint ??
          "Sending is not allowed on this connection. Save a draft instead, or re-authorise and allow sending.",
      );
    }
  };

  async function resolveAttachments(client: JmapClient, list: any[] | undefined): Promise<OutgoingAttachment[]> {
    const out: OutgoingAttachment[] = [];
    for (const a of list ?? []) {
      if (a.from_email_id && a.attachment_id) {
        const found = (await client.read(a.from_email_id)).attachments.find((x) => x.id === a.attachment_id);
        if (!found) throw new Error(`Attachment ${a.attachment_id} is not on email ${a.from_email_id}.`);
        out.push({ name: a.name || found.name, type: a.type || found.type, blobId: found.id });
      } else if (a.content_base64) {
        if (!a.name) throw new Error("An attachment with content_base64 needs a name.");
        out.push({ name: a.name, type: a.type, bytes: base64ToBytes(a.content_base64) });
      } else if (a.path && ctx.readFile) {
        const f = await ctx.readFile(a.path);
        out.push({ name: a.name || f.name, type: a.type || f.type, bytes: f.bytes });
      } else {
        throw new Error("Each attachment needs content_base64, a path, or from_email_id with attachment_id.");
      }
    }
    return out;
  }

  const fmt = (f: unknown) => f as BodyFormat | undefined;
  const READ = { readOnlyHint: true, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const SEND = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  const tool = (name: string, desc: string, schema: any, hints: any, run: (a: any) => Promise<any>) =>
    server.tool(name, desc, schema, hints, async (a: any) => {
      try {
        return await run(a);
      } catch (e) {
        return fail(e);
      }
    });

  tool("whoami", "Show which mailbox this connection uses and whether it may send.", { ...account }, READ, async (a) =>
    text(`Connected as ${ctx.client(a.account).address}. Sending ${ctx.canSend() ? "allowed" : "not allowed; drafts only"}.`),
  );

  if (ctx.accounts) {
    tool("list_accounts", "List the mailboxes this server can use.", {}, READ, async () =>
      text(ctx.accounts!().map((a) => `- ${a.name}: ${a.address}`).join("\n") || "No accounts configured."),
    );
  }

  tool("list_mailboxes", "List folders with message and unread counts.", { ...account }, READ, async (a) => {
    const list = await ctx.client(a.account).listMailboxes();
    return text(list.map((m) => `- ${m.name}${m.role ? ` [${m.role}]` : ""}: ${m.total} messages, ${m.unread} unread`).join("\n"));
  });

  tool(
    "list_recent_emails",
    "List the most recent emails in a folder, newest first.",
    {
      mailbox: z.string().optional().describe('Folder role or name. Default "inbox".'),
      limit: z.number().int().min(1).max(100).optional().describe("How many (default 10)."),
      offset: z.number().int().min(0).optional().describe("Skip this many, for paging."),
      unread_only: z.boolean().optional().describe("Only unread messages."),
      ...account,
    },
    READ,
    async (a) => {
      const box = a.mailbox ?? "inbox";
      const list = await across(a, (c) => c.listRecent(a.limit ?? 10, box, a.unread_only, a.offset ?? 0));
      return text(fmtList(`"${box}"`, list.slice(0, a.limit ?? 10)));
    },
  );

  tool(
    "search_emails",
    "Search email. Combine free text with filters; all given filters must match. With several mailboxes and no account, searches them all.",
    {
      query: z.string().optional().describe("Free text across sender, subject and body."),
      from: z.string().optional().describe("Sender contains."),
      to: z.string().optional().describe("Recipient contains."),
      subject: z.string().optional().describe("Subject contains."),
      after: z.string().optional().describe("Received after this date, e.g. 2026-10-01."),
      before: z.string().optional().describe("Received before this date."),
      has_attachment: z.boolean().optional().describe("Only with, or only without, attachments."),
      unread_only: z.boolean().optional().describe("Only unread messages."),
      mailbox: z.string().optional().describe("Limit to one folder."),
      limit: z.number().int().min(1).max(100).optional().describe("How many (default 10)."),
      offset: z.number().int().min(0).optional().describe("Skip this many, for paging."),
      ...account,
    },
    READ,
    async (a) =>
      text(
        fmtList(
          "search results",
          (await across(a, (c) => c.search({
            text: a.query,
            from: a.from,
            to: a.to,
            subject: a.subject,
            after: a.after,
            before: a.before,
            hasAttachment: a.has_attachment,
            unread: a.unread_only,
            mailbox: a.mailbox,
            limit: a.limit,
            offset: a.offset,
          }))).slice(0, a.limit ?? 10),
        ),
      ),
  );

  tool(
    "read_email",
    "Read one email: its text and a list of attachments. HTML mail is converted to text.",
    { id: z.string().describe("The email id."), ...account },
    READ,
    async (a) => text(fmtEmail(await ctx.client(a.account).read(a.id))),
  );

  tool(
    "get_thread",
    "Read the whole conversation an email belongs to, oldest first.",
    { id: z.string().describe("Any email id in the thread."), ...account },
    READ,
    async (a) => {
      const list = await ctx.client(a.account).thread(a.id);
      return text(`${list.length} message(s) in thread:\n\n${list.map(fmtEmail).join("\n\n---\n\n")}`);
    },
  );

  tool(
    "get_attachment",
    "Open an attachment. Text and PDF come back as text, images as images, other files as a binary resource." +
      (ctx.writeFile ? " Give save_to to write it to a local file instead." : ""),
    {
      email_id: z.string().describe("The email the attachment belongs to."),
      attachment_id: z.string().describe("The attachment_id shown by read_email."),
      ...(ctx.writeFile ? { save_to: z.string().optional().describe("Local path to save the file to.") } : {}),
      ...account,
    },
    READ,
    async (a) => {
      const f = await ctx.client(a.account).downloadAttachment(a.email_id, a.attachment_id);
      if (a.save_to && ctx.writeFile) {
        await ctx.writeFile(a.save_to, f.bytes);
        return text(`Saved ${f.name} (${size(f.bytes.length)}) to ${a.save_to}.`);
      }
      const label = `${f.name} (${f.type}, ${size(f.bytes.length)})`;
      if (isTextType(f.type, f.name)) {
        const t = new TextDecoder().decode(f.bytes);
        return text(`${label}\n\n${t.slice(0, MAX_TEXT_CHARS)}${t.length > MAX_TEXT_CHARS ? "\n\n[Truncated.]" : ""}`);
      }
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        const t = await pdfText(f.bytes);
        if (t) return text(`${label}\n\n${t.slice(0, MAX_TEXT_CHARS)}${t.length > MAX_TEXT_CHARS ? "\n\n[Truncated.]" : ""}`);
      }
      if (f.bytes.length > MAX_INLINE_BYTES) {
        throw new Error(`${label} is too large to return here.`);
      }
      const data = bytesToBase64(f.bytes);
      if (f.type.startsWith("image/")) {
        return { content: [{ type: "text", text: label }, { type: "image", data, mimeType: f.type }] };
      }
      return {
        content: [
          { type: "text", text: label },
          { type: "resource", resource: { uri: `lettio://attachment/${a.attachment_id}`, mimeType: f.type, blob: data } },
        ],
      };
    },
  );

  tool(
    "send_email",
    "Send an email from this mailbox. This really sends, and the sender is always this mailbox. " +
      "Write in Markdown; recipients get formatted HTML with a plain-text version.",
    message,
    SEND,
    async (a) => {
      requireSend();
      const c = ctx.client(a.account);
      const atts = await resolveAttachments(c, a.attachments);
      const r = await c.send({ to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, body: a.body, format: fmt(a.format), attachments: atts, signature: a.signature });
      return text(`Sent from ${c.address} to ${r.accepted.join(", ")}.${notDelivered(r)}`);
    },
  );

  tool(
    "reply_email",
    "Reply in the same conversation and send it. Replies to the sender, or to everyone with reply_all.",
    reply,
    SEND,
    async (a) => {
      requireSend();
      const c = ctx.client(a.account);
      const atts = await resolveAttachments(c, a.attachments);
      const r = await c.reply(a.id, { body: a.body, format: fmt(a.format), replyAll: a.reply_all, attachments: atts, signature: a.signature });
      return text(`Reply sent to ${r.accepted.join(", ")}.${notDelivered(r)}`);
    },
  );

  tool(
    "create_draft",
    "Save a new message to Drafts without sending it.",
    message,
    WRITE,
    async (a) => {
      const c = ctx.client(a.account);
      const atts = await resolveAttachments(c, a.attachments);
      const id = await c.createDraft({ to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, body: a.body, format: fmt(a.format), attachments: atts, signature: a.signature });
      return text(`Draft saved [${id}]. Nothing was sent.`);
    },
  );

  tool(
    "create_reply_draft",
    "Save a reply to Drafts, in the same conversation, without sending it.",
    reply,
    WRITE,
    async (a) => {
      const c = ctx.client(a.account);
      const atts = await resolveAttachments(c, a.attachments);
      const id = await c.createReplyDraft(a.id, { body: a.body, format: fmt(a.format), replyAll: a.reply_all, attachments: atts, signature: a.signature });
      return text(`Reply draft saved [${id}]. Nothing was sent.`);
    },
  );

  tool(
    "send_draft",
    "Send a draft that is already in Drafts. This really sends.",
    { id: z.string().describe("The draft's email id."), ...account },
    SEND,
    async (a) => {
      requireSend();
      const r = await ctx.client(a.account).sendDraft(a.id);
      return text(`Draft sent to ${r.accepted.join(", ")}.${notDelivered(r)}`);
    },
  );

  tool(
    "get_signature",
    "Show the signature that is added to outgoing mail.",
    { ...account },
    READ,
    async (a) => {
      const sig = await ctx.client(a.account).getSignature();
      return text(sig.text || sig.html ? `Text:\n${sig.text}\n\nHTML:\n${sig.html}` : "No signature set.");
    },
  );

  tool(
    "set_signature",
    "Set the signature added to outgoing mail. Stored on the mailbox, so it applies to every client that reads it.",
    {
      text: z.string().describe("Plain-text signature, one item per line, name first."),
      html: z.string().optional().describe("Optional HTML version. Built from the text when omitted."),
      ...account,
    },
    WRITE,
    async (a) => {
      const c = ctx.client(a.account);
      await c.setSignature(a.html ?? textSignatureToHtml(a.text, c.brand), a.text);
      return text("Signature saved.");
    },
  );

  tool(
    "set_read_status",
    "Mark emails read or unread.",
    { ...ids, read: z.boolean().describe("true for read, false for unread.") },
    WRITE,
    async (a) => {
      await ctx.client(a.account).markRead(a.ids, a.read);
      return text(`Marked ${a.ids.length} as ${a.read ? "read" : "unread"}.`);
    },
  );

  tool(
    "flag_email",
    "Flag (star) or unflag emails.",
    { ...ids, flagged: z.boolean().describe("true to flag, false to remove the flag.") },
    WRITE,
    async (a) => {
      await ctx.client(a.account).flag(a.ids, a.flagged);
      return text(`${a.flagged ? "Flagged" : "Unflagged"} ${a.ids.length}.`);
    },
  );

  tool(
    "label_email",
    "Add or remove a label on emails.",
    {
      ...ids,
      label: z.string().describe("Label name: letters, digits, dot, dash or underscore."),
      add: z.boolean().optional().describe("false removes the label. Default true."),
    },
    WRITE,
    async (a) => {
      await ctx.client(a.account).label(a.ids, a.label, a.add !== false);
      return text(`Label "${a.label}" ${a.add === false ? "removed from" : "added to"} ${a.ids.length}.`);
    },
  );

  tool(
    "move_email",
    'Move emails to a folder. Use "archive", "trash" (reversible), "inbox", or a folder name.',
    { ...ids, mailbox: z.string().describe("Target folder role or name.") },
    WRITE,
    async (a) => {
      await ctx.client(a.account).move(a.ids, a.mailbox);
      return text(`Moved ${a.ids.length} to "${a.mailbox}".`);
    },
  );

  tool(
    "create_folder",
    "Create a mail folder, optionally inside another.",
    {
      name: z.string().min(1).describe("Folder name."),
      parent: z.string().optional().describe("Parent folder role or name."),
      ...account,
    },
    WRITE,
    async (a) => {
      await ctx.client(a.account).createMailbox(a.name, a.parent);
      return text(`Folder "${a.name}" created.`);
    },
  );
}
