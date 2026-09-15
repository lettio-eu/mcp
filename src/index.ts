#!/usr/bin/env node
/**
 * Lettio MCP server.
 * Lets an AI agent read, search and send email from a private, EU-hosted
 * Lettio mailbox over JMAP. Supports one or many accounts.
 *
 * Configuration (environment variables):
 *   Single account:
 *     LETTIO_USERNAME   full email, e.g. you@yourcompany.eu
 *     LETTIO_PASSWORD   mailbox (app) password
 *     LETTIO_HOST       mail host (default https://mail.lettio.eu)
 *     LETTIO_ACCOUNT_NAME  optional friendly name (default = username)
 *   Multiple accounts:
 *     LETTIO_ACCOUNTS   JSON array:
 *       [{ "name": "work", "username": "...", "password": "...", "host": "..." }, ...]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JmapClient, EmailSummary } from "./jmap.js";

const DEFAULT_HOST = process.env.LETTIO_HOST || "https://mail.lettio.eu";

type AccountConfig = { name: string; host: string; username: string; password: string };

function loadAccounts(): AccountConfig[] {
  const multi = process.env.LETTIO_ACCOUNTS;
  if (multi) {
    const arr = JSON.parse(multi) as any[];
    return arr.map((a) => ({
      name: a.name || a.username,
      host: a.host || DEFAULT_HOST,
      username: a.username,
      password: a.password,
    }));
  }
  const username = process.env.LETTIO_USERNAME;
  const password = process.env.LETTIO_PASSWORD;
  if (username && password) {
    return [
      {
        name: process.env.LETTIO_ACCOUNT_NAME || username,
        host: DEFAULT_HOST,
        username,
        password,
      },
    ];
  }
  return [];
}

const accounts = loadAccounts();
const clients = new Map<string, JmapClient>();
const accountMeta = new Map<string, { username: string; host: string }>();
for (const a of accounts) {
  clients.set(a.name, new JmapClient(a.host, a.username, a.password));
  accountMeta.set(a.name, { username: a.username, host: a.host });
}

function pick(account?: string): { name: string; client: JmapClient } {
  if (clients.size === 0) {
    throw new Error(
      "No Lettio account configured. Set LETTIO_USERNAME and LETTIO_PASSWORD (or LETTIO_ACCOUNTS).",
    );
  }
  if (account) {
    const c = clients.get(account);
    if (!c) {
      throw new Error(
        `Unknown account "${account}". Available: ${[...clients.keys()].join(", ")}`,
      );
    }
    return { name: account, client: c };
  }
  const name = [...clients.keys()][0];
  return { name, client: clients.get(name)! };
}

function fmtList(name: string, emails: EmailSummary[]): string {
  if (!emails.length) return `No messages found in "${name}".`;
  const lines = emails.map((e, i) => {
    const when = e.receivedAt ? new Date(e.receivedAt).toLocaleString() : "";
    const att = e.hasAttachment ? " 📎" : "";
    return `${i + 1}. [${e.id}]${att}\n   From: ${e.from}\n   ${when} — ${e.subject}\n   ${e.preview}`;
  });
  return `Mailbox "${name}" — ${emails.length} message(s):\n\n${lines.join("\n\n")}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const server = new McpServer({ name: "lettio-mcp", version: "0.1.0" });

server.tool(
  "list_accounts",
  "List the Lettio mailboxes this server is configured to access.",
  {},
  async () => {
    if (accountMeta.size === 0) return text("No accounts configured.");
    const lines = [...accountMeta.entries()].map(
      ([name, m]) => `- ${name} (${m.username} @ ${m.host})`,
    );
    return text(`Configured Lettio accounts:\n${lines.join("\n")}`);
  },
);

server.tool(
  "list_recent_emails",
  "List the most recent emails in a Lettio mailbox (defaults to the inbox).",
  {
    account: z.string().optional().describe("Which configured account to use. Omit to use the first."),
    limit: z.number().int().min(1).max(50).optional().describe("How many messages (default 10)."),
    mailbox: z.string().optional().describe('Mailbox role or name, e.g. "inbox", "sent". Default inbox.'),
  },
  async ({ account, limit, mailbox }) => {
    try {
      const { name, client } = pick(account);
      const emails = await client.listRecent(limit ?? 10, mailbox ?? "inbox");
      return text(fmtList(`${name} / ${mailbox ?? "inbox"}`, emails));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "search_emails",
  "Search a Lettio mailbox by free-text query (matches sender, subject and body).",
  {
    query: z.string().min(1).describe("Text to search for."),
    account: z.string().optional().describe("Which configured account to use."),
    limit: z.number().int().min(1).max(50).optional().describe("How many results (default 10)."),
  },
  async ({ query, account, limit }) => {
    try {
      const { name, client } = pick(account);
      const emails = await client.search(query, limit ?? 10);
      return text(fmtList(`${name} — search "${query}"`, emails));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "read_email",
  "Read the full content of one email by its id (get ids from list/search first).",
  {
    id: z.string().describe("The email id."),
    account: z.string().optional().describe("Which configured account the email belongs to."),
  },
  async ({ id, account }) => {
    try {
      const { client } = pick(account);
      const e = await client.read(id);
      const when = e.receivedAt ? new Date(e.receivedAt).toLocaleString() : "";
      const head = [
        `From: ${e.from}`,
        `To: ${e.to}`,
        e.cc ? `Cc: ${e.cc}` : "",
        `Date: ${when}`,
        `Subject: ${e.subject}`,
      ].filter(Boolean).join("\n");
      return text(`${head}\n\n${e.body || "(no text body)"}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "send_email",
  "Send an email from a Lettio mailbox. Use deliberately — this really sends.",
  {
    to: z.array(z.string().email()).min(1).describe("Recipient email addresses."),
    subject: z.string().describe("Subject line."),
    body: z.string().describe("Plain-text body."),
    cc: z.array(z.string().email()).optional().describe("Optional Cc recipients."),
    account: z.string().optional().describe("Which configured account to send from."),
  },
  async ({ to, subject, body, cc, account }) => {
    try {
      const { name, client } = pick(account);
      await client.send(to, subject, body, cc ?? []);
      return text(`Sent from "${name}" to ${to.join(", ")}${cc?.length ? ` (cc ${cc.join(", ")})` : ""}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_mailboxes",
  "List the folders (mailboxes) in a Lettio account, with message and unread counts.",
  {
    account: z.string().optional().describe("Which configured account to use."),
  },
  async ({ account }) => {
    try {
      const { name, client } = pick(account);
      const boxes = await client.listMailboxes();
      if (!boxes.length) return text(`No mailboxes found in "${name}".`);
      const lines = boxes
        .sort((a, b) => (a.role && !b.role ? -1 : !a.role && b.role ? 1 : a.name.localeCompare(b.name)))
        .map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""} — ${m.total} message(s), ${m.unread} unread`);
      return text(`Mailboxes in "${name}":\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "reply_email",
  "Reply to an email, keeping it in the same conversation thread. Sends as the mailbox only.",
  {
    id: z.string().describe("The id of the email to reply to."),
    body: z.string().describe("Plain-text reply body."),
    reply_all: z.boolean().optional().describe("Also reply to the other recipients (Cc them). Default false."),
    account: z.string().optional().describe("Which configured account the email belongs to."),
  },
  async ({ id, body, reply_all, account }) => {
    try {
      const { name, client } = pick(account);
      await client.reply(id, body, reply_all ?? false);
      return text(`Replied from "${name}"${reply_all ? " to all" : ""}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "set_read_status",
  "Mark an email as read or unread.",
  {
    id: z.string().describe("The email id."),
    read: z.boolean().describe("true to mark read, false to mark unread."),
    account: z.string().optional().describe("Which configured account the email belongs to."),
  },
  async ({ id, read, account }) => {
    try {
      const { client } = pick(account);
      await client.markRead(id, read);
      return text(`Marked ${read ? "read" : "unread"}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "flag_email",
  "Flag (star) or unflag an email.",
  {
    id: z.string().describe("The email id."),
    flagged: z.boolean().describe("true to flag/star, false to remove the flag."),
    account: z.string().optional().describe("Which configured account the email belongs to."),
  },
  async ({ id, flagged, account }) => {
    try {
      const { client } = pick(account);
      await client.flag(id, flagged);
      return text(flagged ? "Flagged." : "Flag removed.");
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "move_email",
  'Move an email to another folder. Use "archive" to archive, "trash" to move to Trash (reversible), or a folder name.',
  {
    id: z.string().describe("The email id."),
    mailbox: z.string().describe('Target folder: role like "archive", "trash", "inbox", or a folder name.'),
    account: z.string().optional().describe("Which configured account the email belongs to."),
  },
  async ({ id, mailbox, account }) => {
    try {
      const { client } = pick(account);
      await client.move(id, mailbox);
      return text(`Moved to "${mailbox}".`);
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so it doesn't corrupt the stdio protocol
  console.error(
    `Lettio MCP running · ${clients.size} account(s): ${[...clients.keys()].join(", ") || "none"}`,
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
