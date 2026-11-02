/**
 * Message formatting shared by the local and hosted servers.
 * Runs on Node and Cloudflare Workers, so no Node-only APIs here.
 */

import { Marked, type Tokens } from "marked";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

/** How mail from one domain looks. Every colour is a hex value. */
export type Brand = {
  /** Headings, table heads, numbered steps and buttons. */
  primary: string;
  /** Links and the quote bar. */
  accent: string;
  /** Body text. */
  text?: string;
  /** Secondary text, captions and quote attribution. */
  muted?: string;
  /** Lines and table borders. */
  line?: string;
  /** Tinted backgrounds: table heads, callouts, code. */
  soft?: string;
  /** Font stack. A web font only loads in clients that allow it. */
  font?: string;
  /** Optional web font stylesheet, e.g. a Google Fonts URL. */
  fontUrl?: string;
};

/** Used when a domain has no brand of its own. */
export const DEFAULT_BRAND: Brand = { primary: "#1f2a37", accent: "#0c7b65" };

const ALERTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

function theme(b: Brand) {
  return {
    primary: b.primary,
    accent: b.accent,
    text: b.text ?? "#2b2b33",
    muted: b.muted ?? "#6b6b78",
    line: b.line ?? "#e6e6ec",
    soft: b.soft ?? "#f5f5f8",
    font: b.font ?? "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  };
}

/** A hairline that reads in light and dark mode. Outlook keeps the solid fallback colour. */
function hairline(side: "border" | "border-top", solid: string): string {
  return `${side}:1px solid ${solid};${side}-color:rgba(128,128,140,0.28)`;
}

function emailMarked(b: Brand): Marked {
  const t = theme(b);
  const font = (size: string, weight = 400, extra = "") => `font-family:${t.font};font-size:${size};font-weight:${weight};${extra}`;
  const P = `margin:0 0 14px;${font("15px", 400, "line-height:1.6;")}color:${t.text}`;
  const block = (inner: string, margin = "6px 0 18px") =>
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:${margin};border-collapse:collapse">${inner}</table>`;

  return new Marked({
    gfm: true,
    breaks: true,
    async: false,
    renderer: {
      // Raw HTML in an agent's text is shown as text, never rendered.
      html({ text }) {
        return escapeHtml(text);
      },
      paragraph({ tokens }) {
        return `<p style="${P}">${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        const size = depth === 1 ? "21px" : depth === 2 ? "18px" : "16px";
        return `<h${depth} style="margin:26px 0 10px;${font(size, 600, "line-height:1.3;")}color:${t.primary}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      strong({ tokens }) {
        return `<strong style="font-weight:600">${this.parser.parseInline(tokens)}</strong>`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!SAFE_LINK.test(href)) return label;
        const url = escapeHtml(href);
        if (title === "button") {
          return `</p>${block(
            `<tr><td style="background:${t.primary};border-radius:8px"><a href="${url}" style="display:inline-block;padding:11px 20px;${font("14px", 600)}color:#ffffff;text-decoration:none">${label}</a></td></tr>`,
            "8px 0 22px",
          ).replace('width="100%" ', "")}<p style="${P}">`;
        }
        return `<a href="${url}" style="color:${t.accent};font-weight:600;text-decoration:underline">${label}</a>`;
      },
      image({ href, text }) {
        return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}" style="color:${t.accent}">${escapeHtml(text || href)}</a>` : escapeHtml(text);
      },
      codespan({ text }) {
        return `<code style="padding:1px 5px;background:${t.soft};border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:13px;color:${t.primary}">${text}</code>`;
      },
      code({ text }) {
        return block(
          `<tr><td style="padding:12px 14px;background:${t.soft};border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:${t.primary};white-space:pre-wrap">${escapeHtml(text)}</td></tr>`,
          "4px 0 18px",
        );
      },
      hr() {
        return `<hr style="border:0;${hairline("border-top", t.line)};margin:22px 0">`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const first = tokens[0] as Tokens.Paragraph | undefined;
        const alert = first?.type === "paragraph" ? /^\[!(\w+)\][ \t]*(.*)/.exec(first.text) : null;
        if (alert && ALERTS[alert[1].toUpperCase()]) {
          const [line, ...rest] = first!.text.split("\n");
          const title = line.replace(/^\[!\w+\][ \t]*/, "") || ALERTS[alert[1].toUpperCase()];
          const body = [rest.join("\n"), ...tokens.slice(1).map((x) => x.raw)].join("\n").trim();
          const inner = body ? this.parser.parse(emailMarked(b).lexer(body)) : "";
          return block(
            `<tr><td style="padding:14px 18px;background:${t.soft};border-radius:8px"><div style="${font("14px", 600)}color:${t.primary};margin-bottom:4px">${escapeHtml(title)}</div>${inner.replace(/margin:0 0 14px;/g, "margin:0;").replace(/font-size:15px/g, "font-size:14px")}</td></tr>`,
          );
        }
        let inner = this.parser.parse(tokens);
        inner = inner.replace(
          /<p style="[^"]*">(?:—|–|-{1,2})\s*([\s\S]*?)<\/p>\s*$/,
          (_w, who: string) => `<div style="margin-top:6px;${font("13px")}color:${t.muted};font-style:normal">${who}</div>`,
        );
        return block(
          `<tr><td width="3" data-bar="1" style="background:${t.accent}"></td><td style="padding:10px 16px;font-style:italic">${inner.replace(/margin:0 0 14px;/g, "margin:0 0 6px;")}</td></tr>`,
        );
      },
      list(token: Tokens.List) {
        const items = token.items.map((item) => this.parser.parse(item.tokens).replace(/<p style="[^"]*">([\s\S]*?)<\/p>/g, "$1").trim());
        if (token.ordered) {
          const start = typeof token.start === "number" ? token.start : 1;
          const rows = items
            .map(
              (html, i) =>
                `<tr><td valign="top" width="30" style="padding:0 0 10px"><div data-step="${start + i}" style="width:22px;height:22px;border-radius:11px;background:${t.primary};color:#ffffff;${font("12px", 600, "line-height:22px;")}text-align:center">${start + i}</div></td><td style="padding:1px 0 10px;${font("15px", 400, "line-height:1.5;")}color:${t.text}">${html}</td></tr>`,
            )
            .join("");
          return block(rows, "4px 0 14px").replace('width="100%" ', "");
        }
        return `<ul style="margin:0 0 14px;padding-left:22px;${font("15px", 400, "line-height:1.6;")}color:${t.text}">${items.map((h) => `<li style="margin:0 0 4px">${h}</li>`).join("")}</ul>`;
      },
      table(token: Tokens.Table) {
        const align = (i: number) => token.align[i] ?? "left";
        const head = token.header
          .map((c, i) => `<th align="${align(i)}" style="padding:10px 14px;background:${t.soft};color:${t.primary};${font("13px", 600)}text-align:${align(i)}">${this.parser.parseInline(c.tokens)}</th>`)
          .join("");
        const rows = token.rows
          .map(
            (r) =>
              `<tr>${r
                .map((c, i) => `<td align="${align(i)}" style="padding:10px 14px;${hairline("border-top", t.line)};${font("14px")}color:${t.text};text-align:${align(i)}">${this.parser.parseInline(c.tokens)}</td>`)
                .join("")}</tr>`,
          )
          .join("");
        return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:4px 0 18px;border-collapse:collapse;${hairline("border", t.line)}"><tr>${head}</tr>${rows}</table>`;
      },
    },
  });
}

/** The fallback signature layout when the mailbox has a plain-text signature only. */
export function textSignatureToHtml(sig: string, brand: Brand = DEFAULT_BRAND): string {
  const t = theme(brand);
  const lines = sig.trim().split("\n").map((l) => escapeHtml(l));
  const [name, ...rest] = lines;
  return `<div style="font-family:${t.font};font-size:15px;font-weight:600;color:${t.primary}">${name}</div><div style="font-family:${t.font};font-size:13px;line-height:1.7;color:${t.muted}">${rest.join("<br>")}</div>`;
}

/** Convert Markdown to a styled, self-contained HTML email. */
export function renderEmail(md: string, brand: Brand = DEFAULT_BRAND, signatureHtml?: string): string {
  const t = theme(brand);
  // An empty <p> left by a button inside a paragraph is dropped.
  const inner = (emailMarked(brand).parse(md) as string).replace(/<p style="[^"]*">\s*<\/p>/g, "");
  const sig = signatureHtml
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:26px;border-collapse:collapse"><tr><td style="${hairline("border-top", t.line)};padding-top:16px">${signatureHtml}</td></tr></table>`
    : "";
  const fontLink = brand.fontUrl ? `<link href="${escapeHtml(brand.fontUrl)}" rel="stylesheet">` : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${fontLink}</head>` +
    `<body style="margin:0;padding:0">` +
    `<div style="max-width:640px;padding:8px 4px;font-family:${t.font};color:${t.text}">${inner}${sig}</div></body></html>`
  );
}

/** Kept for callers that only need plain styled HTML. */
export function markdownToHtml(md: string): string {
  return renderEmail(md);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Number the items of each list, innermost first so nested lists stay intact. */
function numberLists(html: string): string {
  const inner = /<ol\b[^>]*>((?:(?!<ol\b|<\/ol>)[\s\S])*)<\/ol>/gi;
  let prev = "";
  while (prev !== html) {
    prev = html;
    html = html.replace(inner, (_w, items: string) => {
      let n = 0;
      return `\n${items.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `)}\n`;
    });
  }
  return html;
}

/** Convert an HTML email into readable text, keeping links, lists and table rows. */
export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/\s*(<\/?(?:table|thead|tbody|tfoot|tr|td|th|ul|ol|li)\b[^>]*>)\s*/gi, "$1")
    .replace(/<td[^>]*data-bar[^>]*><\/td>/gi, "")
    .replace(/<\/td><\/tr><tr><td[^>]*>(?=<div[^>]*data-step)/gi, "")
    .replace(/<div[^>]*data-step="(\d+)"[^>]*>\d+<\/div><\/td><td[^>]*>/gi, "\n$1. ")
    .replace(/<\/td><\/tr><\/table>/gi, "</table>");
  let s = numberLists(cleaned)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text || href.toLowerCase().startsWith("mailto:") || text === href) return text || href;
      return `${text} (${href})`;
    })
    .replace(/<img\b[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, "[$1]")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>(?=<t[dh]\b)/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(p|div|table|ul|ol|h[1-6]|blockquote|section|article)>/gi, "\n\n")
    .replace(/<(p|h[1-6]|blockquote|ul|table)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^[| ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
