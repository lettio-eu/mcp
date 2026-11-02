/**
 * JMAP client for Lettio, shared by the local and hosted MCP servers.
 * Runs on Node and Cloudflare Workers, so no Node-only APIs here.
 */

import { type Brand, DEFAULT_BRAND, bytesToBase64, htmlToText, renderEmail, textSignatureToHtml } from "./format.js";

const CAP_CORE = "urn:ietf:params:jmap:core";
const CAP_MAIL = "urn:ietf:params:jmap:mail";
const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";

/** Abort a JMAP request that hangs, so a tool call can never block forever. */
const REQUEST_TIMEOUT_MS = 20000;
const BLOB_TIMEOUT_MS = 60000;
/** Longest body returned for one message. Beyond this it is cut and marked. */
const MAX_BODY_BYTES = 200000;

const SUMMARY_PROPS = [
  "id", "threadId", "from", "to", "subject", "receivedAt", "preview", "hasAttachment", "keywords",
];
const FULL_PROPS = [
  ...SUMMARY_PROPS, "cc", "bodyValues", "textBody", "htmlBody", "attachments",
];

type Session = {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
  maxSizeUpload: number;
};

export type BodyFormat = "markdown" | "plain";

/** A file to attach: new content, or a blob already in this mailbox. */
export type OutgoingAttachment =
  | { name: string; type?: string; bytes: Uint8Array }
  | { name: string; type?: string; blobId: string };

export type SearchOptions = {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  mailbox?: string;
  limit?: number;
  offset?: number;
};

export type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  inline: boolean;
};

export type EmailSummary = {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
  threadId: string;
  unread: boolean;
  flagged: boolean;
  labels: string[];
};

export type EmailFull = EmailSummary & {
  cc: string;
  body: string;
  truncated: boolean;
  attachments: Attachment[];
  /** The original HTML part, unsanitised. Only for display after sanitising. */
  html: string;
};

function addrs(list: Array<{ name?: string; email: string }> | null | undefined): string {
  if (!list || !list.length) return "";
  return list
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
}

export type Outgoing = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  format?: BodyFormat;
  attachments?: OutgoingAttachment[];
  /** Append the mailbox signature. Default true. */
  signature?: boolean;
};

/** What the mail server did with a send, per recipient. */
export type SendResult = {
  /** The EmailSubmission id. */
  id: string;
  /** Recipients the server accepted for delivery. */
  accepted: string[];
  /** Recipients it refused, with its SMTP reply. */
  rejected: Array<{ email: string; reason: string }>;
};

function listRejected(rejected: SendResult["rejected"]): string {
  return rejected.map((r) => `${r.email}: ${r.reason.replace(/\.$/, "")}`).join("; ");
}

/** " Not delivered to …" for a partial send, or "" when everyone got it. */
export function notDelivered(r: SendResult): string {
  return r.rejected.length ? ` Not delivered to ${listRejected(r.rejected)}.` : "";
}

export type ReplyInput = {
  body: string;
  format?: BodyFormat;
  signature?: boolean;
  replyAll?: boolean;
  attachments?: OutgoingAttachment[];
};

/** JMAP date filters need a UTC date-time. Accepts plain dates too. */
function toUtcDate(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${v}".`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class JmapClient {
  private baseUrl: string;
  private auth: string;
  private fromEmail: string;
  private session?: Session;
  private mailboxes: Record<string, string> = {};
  private identityId?: string;
  private signatureCache?: { html: string; text: string };
  /** How formatted mail from this mailbox looks. */
  brand: Brand = DEFAULT_BRAND;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fromEmail = username;
    this.auth = "Basic " + bytesToBase64(new TextEncoder().encode(`${username}:${password}`));
  }

  /** The address this client is pinned to. */
  get address(): string {
    return this.fromEmail;
  }

  async getSession(): Promise<Session> {
    if (this.session) return this.session;
    const res = await fetch(`${this.baseUrl}/jmap/session`, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JMAP session failed (${res.status}). Check host/credentials.`);
    const j: any = await res.json();
    const accountId = j.primaryAccounts?.[CAP_MAIL];
    if (!accountId) throw new Error("No mail account available for these credentials.");
    this.session = {
      apiUrl: j.apiUrl,
      downloadUrl: j.downloadUrl,
      uploadUrl: j.uploadUrl,
      accountId,
      maxSizeUpload: j.capabilities?.[CAP_CORE]?.maxSizeUpload ?? 0,
    };
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
      this.mailboxes[`id:${mb.id}`] = mb.id;
    }
  }

  private async mailbox(role: string): Promise<string | undefined> {
    await this.loadMailboxes();
    return this.mailboxes[role.toLowerCase()] || this.mailboxes[`name:${role.toLowerCase()}`] || this.mailboxes[`id:${role}`];
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
      threadId: e.threadId || "",
      unread: !e.keywords?.$seen,
      flagged: !!e.keywords?.$flagged,
      labels: Object.keys(e.keywords || {}).filter((k) => !k.startsWith("$")),
    };
  }

  /** Turn a full Email object into readable text, its attachments and metadata. */
  private toFull(e: any): EmailFull {
    let body = "";
    let truncated = false;
    const parts = (e.textBody && e.textBody.length ? e.textBody : e.htmlBody) || [];
    for (const p of parts) {
      const v = e.bodyValues?.[p.partId];
      if (!v?.value) continue;
      if (v.isTruncated) truncated = true;
      body += (p.type === "text/html" ? htmlToText(v.value) : v.value) + "\n";
    }
    let html = "";
    for (const p of e.htmlBody || []) {
      if (p.type === "text/html" && e.bodyValues?.[p.partId]?.value) html += e.bodyValues[p.partId].value;
    }
    const attachments: Attachment[] = (e.attachments || []).map((a: any) => ({
      id: a.blobId,
      name: a.name || "(unnamed)",
      type: a.type || "application/octet-stream",
      size: a.size || 0,
      inline: a.disposition === "inline" || !!a.cid,
    }));
    return { ...this.summarize(e), cc: addrs(e.cc), body: body.trim(), truncated, attachments, html };
  }

  private async query(filter: any, limit: number, offset: number): Promise<EmailSummary[]> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/query",
        {
          accountId: s.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          position: offset,
          limit,
        },
        "0",
      ],
      [
        "Email/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
          properties: SUMMARY_PROPS,
        },
        "1",
      ],
    ]);
    return (r.methodResponses[1][1].list as any[]).map((e) => this.summarize(e));
  }

  async listRecent(limit = 10, mailboxRole = "inbox", unreadOnly = false, offset = 0): Promise<EmailSummary[]> {
    return this.search({ mailbox: mailboxRole, unread: unreadOnly || undefined, limit, offset });
  }

  async search(o: SearchOptions): Promise<EmailSummary[]> {
    const conds: any[] = [];
    if (o.text) conds.push({ text: o.text });
    if (o.from) conds.push({ from: o.from });
    if (o.to) conds.push({ to: o.to });
    if (o.subject) conds.push({ subject: o.subject });
    if (o.after) conds.push({ after: toUtcDate(o.after) });
    if (o.before) conds.push({ before: toUtcDate(o.before) });
    if (o.hasAttachment !== undefined) conds.push({ hasAttachment: o.hasAttachment });
    if (o.unread) conds.push({ notKeyword: "$seen" });
    if (o.mailbox) {
      const id = await this.mailbox(o.mailbox);
      if (!id) throw new Error(`No mailbox "${o.mailbox}" for this account.`);
      conds.push({ inMailbox: id });
    }
    const filter = conds.length > 1 ? { operator: "AND", conditions: conds } : conds[0];
    return this.query(filter, o.limit ?? 10, o.offset ?? 0);
  }

  private async getFull(ids: string[]): Promise<any[]> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/get",
        {
          accountId: s.accountId,
          ids,
          properties: FULL_PROPS,
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: MAX_BODY_BYTES,
        },
        "0",
      ],
    ]);
    return r.methodResponses[0][1].list;
  }

  async read(id: string): Promise<EmailFull> {
    const [e] = await this.getFull([id]);
    if (!e) throw new Error(`Email ${id} not found.`);
    return this.toFull(e);
  }

  /** Every message in the thread that contains this email, oldest first. */
  async thread(id: string): Promise<EmailFull[]> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      ["Email/get", { accountId: s.accountId, ids: [id], properties: ["threadId"] }, "0"],
      [
        "Thread/get",
        {
          accountId: s.accountId,
          "#ids": { resultOf: "0", name: "Email/get", path: "/list/*/threadId" },
        },
        "1",
      ],
    ]);
    const emailIds: string[] = r.methodResponses[1][1].list[0]?.emailIds || [];
    if (!emailIds.length) throw new Error(`Email ${id} not found.`);
    return (await this.getFull(emailIds)).map((e) => this.toFull(e));
  }

  /** Download one attachment. It must belong to `emailId`, so ids can't reach other blobs. */
  async downloadAttachment(emailId: string, attachmentId: string): Promise<Attachment & { bytes: Uint8Array }> {
    const email = await this.read(emailId);
    const att = email.attachments.find((a) => a.id === attachmentId);
    if (!att) throw new Error(`Attachment ${attachmentId} is not on email ${emailId}.`);
    const s = await this.getSession();
    const url = s.downloadUrl
      .replace("{accountId}", encodeURIComponent(s.accountId))
      .replace("{blobId}", encodeURIComponent(att.id))
      .replace("{name}", encodeURIComponent(att.name))
      .replace("{type}", encodeURIComponent(att.type));
    const res = await fetch(url, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Attachment download failed (${res.status}).`);
    return { ...att, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  private async upload(bytes: Uint8Array, type: string): Promise<string> {
    const s = await this.getSession();
    if (s.maxSizeUpload && bytes.length > s.maxSizeUpload) {
      throw new Error(`Attachment is too large (${bytes.length} bytes, limit ${s.maxSizeUpload}).`);
    }
    const res = await fetch(s.uploadUrl.replace("{accountId}", encodeURIComponent(s.accountId)), {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": type },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Attachment upload failed (${res.status}).`);
    const j: any = await res.json();
    return j.blobId;
  }

  /** Fill in body parts and attachments on a message being composed. */
  /** The signature stored on this mailbox's sending identity. */
  async getSignature(): Promise<{ html: string; text: string }> {
    if (this.signatureCache) return this.signatureCache;
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_SUBMISSION], [
      ["Identity/get", { accountId: s.accountId, properties: ["id", "email", "htmlSignature", "textSignature"] }, "0"],
    ]);
    const id = (r.methodResponses[0][1].list as any[]).find(
      (i) => i.email?.toLowerCase() === this.fromEmail.toLowerCase(),
    );
    this.signatureCache = { html: id?.htmlSignature || "", text: id?.textSignature || "" };
    return this.signatureCache;
  }

  /** Store the signature on this mailbox's sending identity, so it applies everywhere. */
  async setSignature(html: string, text: string): Promise<void> {
    const s = await this.getSession();
    const identityId = await this.getIdentityId();
    const r = await this.call([CAP_CORE, CAP_SUBMISSION], [
      ["Identity/set", { accountId: s.accountId, update: { [identityId]: { htmlSignature: html, textSignature: text } } }, "0"],
    ]);
    const failed = r.methodResponses[0][1].notUpdated?.[identityId];
    if (failed) throw new Error(`Could not save the signature: ${JSON.stringify(failed)}`);
    this.signatureCache = { html, text };
  }

  /** The exact HTML a Markdown message would be sent as, signature included. */
  async renderHtml(text: string, withSignature = true): Promise<string> {
    const sig = withSignature ? await this.getSignature() : { html: "", text: "" };
    const sigHtml = sig.html || (sig.text ? textSignatureToHtml(sig.text, this.brand) : "");
    return renderEmail(text, this.brand, sigHtml || undefined);
  }

  private async compose(
    emailObj: any,
    text: string,
    format: BodyFormat,
    attachments: OutgoingAttachment[],
    withSignature = true,
  ): Promise<void> {
    if (format === "plain") {
      const sig = withSignature ? (await this.getSignature()).text : "";
      emailObj.bodyValues = { text: { value: sig ? `${text}\n\n-- \n${sig}` : text } };
      emailObj.textBody = [{ partId: "text", type: "text/plain" }];
    } else {
      const html = await this.renderHtml(text, withSignature);
      emailObj.bodyValues = { text: { value: htmlToText(html) }, html: { value: html } };
      emailObj.textBody = [{ partId: "text", type: "text/plain" }];
      emailObj.htmlBody = [{ partId: "html", type: "text/html" }];
    }
    if (attachments.length) {
      emailObj.attachments = [];
      for (const a of attachments) {
        const type = a.type || "application/octet-stream";
        const blobId = "blobId" in a ? a.blobId : await this.upload(a.bytes, type);
        emailObj.attachments.push({ blobId, type, name: a.name, disposition: "attachment" });
      }
    }
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
  private async submit(emailObj: any, rcptEmails: string[]): Promise<SendResult> {
    const s = await this.getSession();
    const identityId = await this.getIdentityId();
    const draftsId = await this.mailbox("drafts");

    emailObj.mailboxIds = draftsId ? { [draftsId]: true } : {};
    emailObj.from = [{ email: this.fromEmail }];
    emailObj.keywords = { $draft: true, $seen: true };

    const r = await this.call([CAP_CORE, CAP_MAIL, CAP_SUBMISSION], [
      ["Email/set", { accountId: s.accountId, create: { draft: emailObj } }, "0"],
      await this.submissionCall(identityId, "#draft", rcptEmails, draftsId),
    ]);

    const setEmail = r.methodResponses[0][1];
    if (setEmail.notCreated?.draft) {
      throw new Error(`Could not create message: ${JSON.stringify(setEmail.notCreated.draft)}`);
    }
    const result = await this.submissionResult(r.methodResponses[1][1], rcptEmails);
    if (!result.accepted.length) {
      // onSuccessUpdateEmail already moved it to Sent; it went nowhere, so remove it.
      const emailId = setEmail.created?.draft?.id;
      if (emailId) {
        await this.call([CAP_CORE, CAP_MAIL], [["Email/set", { accountId: s.accountId, destroy: [emailId] }, "0"]]).catch(
          () => {},
        );
      }
      throw new Error(`Not sent: the mail server refused every recipient (${listRejected(result.rejected)}).`);
    }
    return result;
  }

  private async submissionCall(
    identityId: string,
    emailId: string,
    rcptEmails: string[],
    draftsId?: string,
  ): Promise<any[]> {
    const s = await this.getSession();
    const sentId = await this.mailbox("sent");
    const onSuccess: any = {};
    if (sentId) onSuccess[`mailboxIds/${sentId}`] = true;
    if (draftsId) onSuccess[`mailboxIds/${draftsId}`] = null;
    onSuccess["keywords/$draft"] = null;
    return [
      "EmailSubmission/set",
      {
        accountId: s.accountId,
        create: {
          sub: {
            identityId,
            emailId,
            envelope: {
              mailFrom: { email: this.fromEmail },
              rcptTo: rcptEmails.map((email) => ({ email })),
            },
          },
        },
        onSuccessUpdateEmail: { "#sub": onSuccess },
      },
      "1",
    ];
  }

  /**
   * A created submission is not proof of sending: Stalwart answers `created`
   * even when it refused every RCPT TO, and only the submission's
   * deliveryStatus (not returned by /set) says so. Read it back and split the
   * recipients into accepted and refused, with the server's SMTP reply.
   */
  private async submissionResult(setSub: any, rcptEmails: string[]): Promise<SendResult> {
    if (setSub.notCreated?.sub) {
      throw new Error(`Could not send: ${JSON.stringify(setSub.notCreated.sub)}`);
    }
    const id = setSub.created?.sub?.id;
    if (!id) throw new Error("Could not send: the mail server did not confirm the submission.");
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_SUBMISSION], [
      ["EmailSubmission/get", { accountId: s.accountId, ids: [id], properties: ["undoStatus", "deliveryStatus"] }, "0"],
    ]);
    const sub = r.methodResponses[0][1].list?.[0];
    if (sub?.undoStatus === "canceled") throw new Error("Not sent: the submission was canceled.");
    const status = new Map(
      Object.entries(sub?.deliveryStatus || {}).map(([email, st]) => [email.toLowerCase(), st as any]),
    );
    const result: SendResult = { id, accepted: [], rejected: [] };
    const seen = new Set<string>();
    for (const email of rcptEmails) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const st = status.get(key);
      // A server that doesn't track delivery leaves it out; only a "no" is a refusal.
      if (st?.delivered === "no") result.rejected.push({ email, reason: String(st.smtpReply || "refused").trim() });
      else result.accepted.push(email);
    }
    return result;
  }

  /** Send a draft already in this mailbox. Its From must be this address. */
  async sendDraft(id: string): Promise<SendResult> {
    const s = await this.getSession();
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      [
        "Email/get",
        { accountId: s.accountId, ids: [id], properties: ["from", "to", "cc", "bcc", "keywords", "mailboxIds"] },
        "0",
      ],
    ]);
    const e = r.methodResponses[0][1].list[0];
    if (!e) throw new Error(`Email ${id} not found.`);
    if (!e.keywords?.$draft) throw new Error("This message is not a draft.");
    const self = this.fromEmail.toLowerCase();
    if (e.from?.length !== 1 || e.from[0].email?.toLowerCase() !== self) {
      throw new Error(`Refusing to send: this draft is not from ${this.fromEmail}.`);
    }
    const rcpt = [...(e.to || []), ...(e.cc || []), ...(e.bcc || [])].map((a: any) => a.email);
    if (!rcpt.length) throw new Error("This draft has no recipients.");
    const identityId = await this.getIdentityId();
    const draftsId = await this.mailbox("drafts");
    const sent = await this.call([CAP_CORE, CAP_MAIL, CAP_SUBMISSION], [
      await this.submissionCall(identityId, id, rcpt, draftsId),
    ]);
    const result = await this.submissionResult(sent.methodResponses[0][1], rcpt);
    if (!result.accepted.length) {
      // onSuccessUpdateEmail already filed it in Sent; put the draft back.
      if (draftsId) {
        await this.call([CAP_CORE, CAP_MAIL], [
          ["Email/set", { accountId: s.accountId, update: { [id]: { mailboxIds: { [draftsId]: true }, "keywords/$draft": true } } }, "0"],
        ]).catch(() => {});
      }
      throw new Error(
        `Not sent: the mail server refused every recipient (${listRejected(result.rejected)}). The draft is still in Drafts.`,
      );
    }
    return result;
  }

  /** Bcc goes in the envelope only, so the address never appears in the message. */
  async send(m: Outgoing): Promise<SendResult> {
    const emailObj = await this.newMessage(m);
    return this.submit(emailObj, [...m.to, ...(m.cc || []), ...(m.bcc || [])]);
  }

  private async newMessage(m: Outgoing): Promise<any> {
    const emailObj: any = { to: m.to.map((email) => ({ email })), subject: m.subject };
    if (m.cc?.length) emailObj.cc = m.cc.map((email) => ({ email }));
    await this.compose(emailObj, m.body, m.format ?? "markdown", m.attachments ?? [], m.signature !== false);
    return emailObj;
  }

  /**
   * File an Email object in Drafts WITHOUT sending it (no EmailSubmission).
   * Like submit(), the sender is pinned to this authenticated mailbox; the
   * message just stays in Drafts (keyword $draft) for the user to review and
   * send from their own mail app. Returns the created email id.
   */
  private async saveDraft(emailObj: any): Promise<string> {
    const s = await this.getSession();
    const draftsId = await this.mailbox("drafts");
    if (!draftsId) throw new Error("No Drafts mailbox found for this account.");
    emailObj.mailboxIds = { [draftsId]: true };
    emailObj.from = [{ email: this.fromEmail }];
    emailObj.keywords = { $draft: true, $seen: true };

    const r = await this.call([CAP_CORE, CAP_MAIL], [
      ["Email/set", { accountId: s.accountId, create: { draft: emailObj } }, "0"],
    ]);
    const setEmail = r.methodResponses[0][1];
    if (setEmail.notCreated?.draft) {
      throw new Error(`Could not create draft: ${JSON.stringify(setEmail.notCreated.draft)}`);
    }
    return setEmail.created?.draft?.id || "draft";
  }

  /** Prepare a draft message in Drafts without sending it. Returns the draft id. */
  async createDraft(m: Outgoing): Promise<string> {
    const emailObj = await this.newMessage(m);
    if (m.bcc?.length) emailObj.bcc = m.bcc.map((email) => ({ email }));
    return this.saveDraft(emailObj);
  }

  /**
   * Build a threaded reply Email object from an original message: recipients
   * (original sender, or Reply-To; reply_all also Ccs the other recipients
   * minus this mailbox), a "Re:" subject, and the In-Reply-To / References
   * chain so it stays in the same thread. Shared by reply() and
   * createReplyDraft() so sending and drafting produce identical messages.
   */
  private async buildReply(id: string, m: ReplyInput): Promise<{ emailObj: any; rcpt: string[] }> {
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
    if (m.replyAll) {
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

    const emailObj: any = { to: to.map((email) => ({ email })), subject };
    await this.compose(emailObj, m.body, m.format ?? "markdown", m.attachments ?? [], m.signature !== false);
    if (cc.length) emailObj.cc = cc.map((email) => ({ email }));
    if (orig.messageId?.length) emailObj.inReplyTo = orig.messageId;
    if (references.length) emailObj.references = references;

    return { emailObj, rcpt: [...to, ...cc] };
  }

  /**
   * Reply to a message, preserving the conversation thread, and send it (only
   * ever from this authenticated mailbox).
   */
  async reply(id: string, m: ReplyInput): Promise<SendResult> {
    const { emailObj, rcpt } = await this.buildReply(id, m);
    return this.submit(emailObj, rcpt);
  }

  /**
   * Prepare a threaded reply as a DRAFT (not sent) — same message reply() would
   * send, filed in Drafts for the user to review and send. Returns the draft id.
   */
  async createReplyDraft(id: string, m: ReplyInput): Promise<string> {
    const { emailObj } = await this.buildReply(id, m);
    return this.saveDraft(emailObj);
  }

  private async update(ids: string[], patch: any, action: string): Promise<void> {
    const s = await this.getSession();
    const update = Object.fromEntries(ids.map((id) => [id, patch]));
    const r = await this.call([CAP_CORE, CAP_MAIL], [["Email/set", { accountId: s.accountId, update }, "0"]]);
    const failed = r.methodResponses[0][1].notUpdated;
    if (failed && Object.keys(failed).length) {
      throw new Error(`Could not ${action}: ${JSON.stringify(failed)}`);
    }
  }

  async markRead(ids: string[], read = true): Promise<void> {
    return this.update(ids, { "keywords/$seen": read ? true : null }, "update read status");
  }

  async flag(ids: string[], flagged = true): Promise<void> {
    return this.update(ids, { "keywords/$flagged": flagged ? true : null }, "update flag");
  }

  /** Labels are JMAP keywords, so they stay on the message and work in any JMAP client. */
  async label(ids: string[], label: string, on = true): Promise<void> {
    const key = label.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{1,60}$/.test(key)) {
      throw new Error("Labels can contain only letters, digits, dot, dash and underscore.");
    }
    return this.update(ids, { [`keywords/${key}`]: on ? true : null }, "update label");
  }

  /** Move messages into another mailbox (e.g. "archive", "trash", or a folder name). */
  async move(ids: string[], targetRole: string): Promise<void> {
    const target = await this.mailbox(targetRole);
    if (!target) throw new Error(`No mailbox "${targetRole}" for this account.`);
    return this.update(ids, { mailboxIds: { [target]: true } }, "move message");
  }

  async createMailbox(name: string, parent?: string): Promise<string> {
    const s = await this.getSession();
    const parentId = parent ? await this.mailbox(parent) : null;
    if (parent && !parentId) throw new Error(`No mailbox "${parent}" for this account.`);
    const r = await this.call([CAP_CORE, CAP_MAIL], [
      ["Mailbox/set", { accountId: s.accountId, create: { box: { name, parentId } } }, "0"],
    ]);
    const res = r.methodResponses[0][1];
    if (res.notCreated?.box) throw new Error(`Could not create folder: ${JSON.stringify(res.notCreated.box)}`);
    this.mailboxes = {};
    return res.created.box.id;
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
