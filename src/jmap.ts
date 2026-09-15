/**
 * Minimal JMAP client for Lettio.
 * Covers what an AI agent needs: list, search, read, send.
 */

const CAP_CORE = "urn:ietf:params:jmap:core";
const CAP_MAIL = "urn:ietf:params:jmap:mail";
const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";

/** Abort a JMAP request that hangs, so a tool call can never block forever. */
const REQUEST_TIMEOUT_MS = 20000;

type Session = { apiUrl: string; accountId: string };

export type EmailSummary = {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
};

export type EmailFull = EmailSummary & {
  cc: string;
  body: string;
};

function addrs(list: Array<{ name?: string; email: string }> | null | undefined): string {
  if (!list || !list.length) return "";
  return list
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
}

export class JmapClient {
  private baseUrl: string;
  private auth: string;
  private fromEmail: string;
  private session?: Session;
  private mailboxes: Record<string, string> = {};
  private identityId?: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fromEmail = username;
    this.auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  private async getSession(): Promise<Session> {
    if (this.session) return this.session;
    const res = await fetch(`${this.baseUrl}/jmap/session`, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JMAP session failed (${res.status}). Check host/credentials.`);
    const j: any = await res.json();
    const accountId = j.primaryAccounts?.[CAP_MAIL];
    if (!accountId) throw new Error("No mail account available for these credentials.");
    this.session = { apiUrl: j.apiUrl, accountId };
    return this.session;
  }

  private async call(using: string[], methodCalls: any[]): Promise<any> {
    const s = await this.getSession();
    const res = await fetch(s.apiUrl, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JMAP request failed (${res.status}): ${await res.text()}`);
    const j: any = await res.json();
    for (const mr of j.methodResponses) {
      if (mr[0] === "error") throw new Error(`JMAP error: ${JSON.stringify(mr[1])}`);
    }
    return j;
  }

  private async loadMailboxes(): Promise<void> {
    if (Object.keys(this.mailboxes).length) return;
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      ["Mailbox/get", { accountId: s.accountId, properties: ["id", "role", "name"] }, "0"],
    ]);
    for (const mb of r.methodResponses[0][1].list) {
      if (mb.role) this.mailboxes[mb.role] = mb.id;
      this.mailboxes[`name:${mb.name.toLowerCase()}`] = mb.id;
    }
  }

  private async mailbox(role: string): Promise<string | undefined> {
    await this.loadMailboxes();
    return this.mailboxes[role] || this.mailboxes[`name:${role.toLowerCase()}`];
  }

  private summarize(e: any): EmailSummary {
    return {
      id: e.id,
      from: addrs(e.from),
      to: addrs(e.to),
      subject: e.subject || "(no subject)",
      receivedAt: e.receivedAt || "",
      preview: (e.preview || "").trim(),
      hasAttachment: !!e.hasAttachment,
    };
  }

  async listRecent(limit = 10, mailboxRole = "inbox"): Promise<EmailSummary[]> {
    const s = await this.getSession();
    const mbId = await this.mailbox(mailboxRole);
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/query",
        {
          accountId: s.accountId,
          filter: mbId ? { inMailbox: mbId } : undefined,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        },
        "0",
      ],
      [
        "Email/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: ["id", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"],
        },
        "1",
      ],
    ]);
    return (r.methodResponses[1][1].list as any[]).map((e) => this.summarize(e));
  }

  async search(query: string, limit = 10): Promise<EmailSummary[]> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/query",
        {
          accountId: s.accountId,
          filter: { text: query },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        },
        "0",
      ],
      [
        "Email/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: ["id", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"],
        },
        "1",
      ],
    ]);
    return (r.methodResponses[1][1].list as any[]).map((e) => this.summarize(e));
  }

  async read(id: string): Promise<EmailFull> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/get",
        {
          accountId: s.accountId,
          ids: [id],
          properties: [
            "id", "from", "to", "cc", "subject", "receivedAt", "preview",
            "hasAttachment", "bodyValues", "textBody", "htmlBody",
          ],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 100000,
        },
        "0",
      ],
    ]);
    const e = r.methodResponses[0][1].list[0];
    if (!e) throw new Error(`Email ${id} not found.`);
    let body = "";
    const parts = (e.textBody && e.textBody.length ? e.textBody : e.htmlBody) || [];
    for (const p of parts) {
      const v = e.bodyValues?.[p.partId];
      if (v?.value) body += v.value + "\n";
    }
    return { ...this.summarize(e), cc: addrs(e.cc), body: body.trim() };
  }

  /**
   * SECURITY: sending is only ever done as this authenticated account's own
   * verified address. We require an Identity whose email matches the login
   * address, so an agent can never be tricked into sending "from" a foreign
   * or arbitrary address — the identity, the From header and the SMTP
   * envelope MAIL FROM are all pinned to this.fromEmail, and the mail server
   * itself only returns identities this account is authorised to use.
   */
  private async getIdentityId(): Promise<string> {
    if (this.identityId) return this.identityId;
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_SUBMISSION], [
      ["Identity/get", { accountId: s.accountId, properties: ["id", "email"] }, "0"],
    ]);
    const list = r.methodResponses[0][1].list as any[];
    const match = list.find((i) => i.email?.toLowerCase() === this.fromEmail.toLowerCase());
    if (!match) {
      throw new Error(
        `This mailbox has no sending identity for ${this.fromEmail}; refusing to send as a different address.`,
      );
    }
    this.identityId = match.id as string;
    return this.identityId;
  }

  /**
   * Shared submission path. Pins the sender to this authenticated mailbox,
   * files the message in Drafts, sends it, then moves it to Sent. `emailObj`
   * carries only the message-specific fields (to/cc/subject/body/threading);
   * from, keywords and mailbox placement are set here so every code path that
   * sends goes through the same address-pinning guarantees.
   */
  private async submit(emailObj: any, rcptEmails: string[]): Promise<string> {
    const s = await this.getSession();
    const identityId = await this.getIdentityId();
    const draftsId = await this.mailbox("drafts");
    const sentId = await this.mailbox("sent");

    emailObj.mailboxIds = draftsId ? { [draftsId]: true } : {};
    emailObj.from = [{ email: this.fromEmail }];
    emailObj.keywords = { $draft: true, $seen: true };

    const onSuccess: any = {};
    if (sentId) onSuccess[`mailboxIds/${sentId}`] = true;
    if (draftsId) onSuccess[`mailboxIds/${draftsId}`] = null;
    onSuccess["keywords/$draft"] = null;

    const r = await this.call([CAP_CORE, CAP_MAIL, CAP_SUBMISSION], [
      ["Email/set", { accountId: s.accountId, create: { draft: emailObj } }, "0"],
      [
        "EmailSubmission/set",
        {
          accountId: s.accountId,
          create: {
            sub: {
              identityId,
              emailId: "#draft",
              envelope: {
                mailFrom: { email: this.fromEmail },
                rcptTo: rcptEmails.map((email) => ({ email })),
              },
            },
          },
          onSuccessUpdateEmail: { "#sub": onSuccess },
        },
        "1",
      ],
    ]);

    const setEmail = r.methodResponses[0][1];
    if (setEmail.notCreated?.draft) {
      throw new Error(`Could not create message: ${JSON.stringify(setEmail.notCreated.draft)}`);
    }
    const setSub = r.methodResponses[1][1];
    if (setSub.notCreated?.sub) {
      throw new Error(`Could not send: ${JSON.stringify(setSub.notCreated.sub)}`);
    }
    return setSub.created?.sub?.id || "sent";
  }

  async send(to: string[], subject: string, text: string, cc: string[] = []): Promise<string> {
    const emailObj: any = {
      to: to.map((email) => ({ email })),
      subject,
      bodyValues: { body: { value: text } },
      textBody: [{ partId: "body", type: "text/plain" }],
    };
    if (cc.length) emailObj.cc = cc.map((email) => ({ email }));
    return this.submit(emailObj, [...to, ...cc]);
  }

  /**
   * Reply to a message, preserving the conversation thread. The reply keeps the
   * original In-Reply-To / References chain and a "Re:" subject, so it lands in
   * the same thread in the recipient's client. Sent, like every message, only
   * from this authenticated mailbox.
   */
  async reply(id: string, text: string, replyAll = false): Promise<string> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/get",
        {
          accountId: s.accountId,
          ids: [id],
          properties: ["from", "to", "cc", "replyTo", "subject", "messageId", "references"],
        },
        "0",
      ],
    ]);
    const orig = r.methodResponses[0][1].list[0];
    if (!orig) throw new Error(`Email ${id} not found.`);

    const self = this.fromEmail.toLowerCase();
    const targets: Array<{ email: string }> =
      (orig.replyTo && orig.replyTo.length ? orig.replyTo : orig.from) || [];
    const to = targets.map((a) => a.email).filter((e) => e);
    if (!to.length) throw new Error("The original message has no address to reply to.");

    let cc: string[] = [];
    if (replyAll) {
      const seen = new Set([self, ...to.map((e) => e.toLowerCase())]);
      for (const a of [...(orig.to || []), ...(orig.cc || [])] as Array<{ email: string }>) {
        const e = a.email;
        if (e && !seen.has(e.toLowerCase())) {
          seen.add(e.toLowerCase());
          cc.push(e);
        }
      }
    }

    const baseSubject = orig.subject || "";
    const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`.trim();
    const references = [...(orig.references || []), ...(orig.messageId || [])];

    const emailObj: any = {
      to: to.map((email) => ({ email })),
      subject,
      bodyValues: { body: { value: text } },
      textBody: [{ partId: "body", type: "text/plain" }],
    };
    if (cc.length) emailObj.cc = cc.map((email) => ({ email }));
    if (orig.messageId?.length) emailObj.inReplyTo = orig.messageId;
    if (references.length) emailObj.references = references;

    return this.submit(emailObj, [...to, ...cc]);
  }

  /** Set or clear a keyword ($seen, $flagged, …) on a message. */
  private async setKeyword(id: string, keyword: string, on: boolean): Promise<void> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/set",
        { accountId: s.accountId, update: { [id]: { [`keywords/${keyword}`]: on ? true : null } } },
        "0",
      ],
    ]);
    const upd = r.methodResponses[0][1];
    if (upd.notUpdated?.[id]) {
      throw new Error(`Could not update message: ${JSON.stringify(upd.notUpdated[id])}`);
    }
  }

  async markRead(id: string, read = true): Promise<void> {
    return this.setKeyword(id, "$seen", read);
  }

  async flag(id: string, flagged = true): Promise<void> {
    return this.setKeyword(id, "$flagged", flagged);
  }

  /** Move a message into another mailbox (e.g. "archive", "trash", or a folder name). */
  async move(id: string, targetRole: string): Promise<void> {
    const s = await this.getSession();
    const target = await this.mailbox(targetRole);
    if (!target) throw new Error(`No mailbox "${targetRole}" for this account.`);
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      ["Email/set", { accountId: s.accountId, update: { [id]: { mailboxIds: { [target]: true } } } }, "0"],
    ]);
    const upd = r.methodResponses[0][1];
    if (upd.notUpdated?.[id]) {
      throw new Error(`Could not move message: ${JSON.stringify(upd.notUpdated[id])}`);
    }
  }

  async listMailboxes(): Promise<
    Array<{ id: string; name: string; role: string; total: number; unread: number }>
  > {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Mailbox/get",
        { accountId: s.accountId, properties: ["id", "name", "role", "totalEmails", "unreadEmails"] },
        "0",
      ],
    ]);
    return (r.methodResponses[0][1].list as any[]).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role || "",
      total: m.totalEmails || 0,
      unread: m.unreadEmails || 0,
    }));
  }
}
