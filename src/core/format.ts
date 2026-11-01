/**
 * Message formatting shared by the local and hosted servers.
 * Runs on Node and Cloudflare Workers, so no Node-only APIs here.
 */

import { Marked } from "marked";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SAFE_LINK = /^(https?:|mailto:)/i;

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // Raw HTML in an agent's text is shown as text, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    },
    image({ href, text }) {
      return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>` : escapeHtml(text);
    },
  },
});

const STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a";

/** Convert Markdown to a self-contained HTML email body. */
export function markdownToHtml(md: string): string {
  const inner = marked.parse(md) as string;
  return `<!doctype html><html><body><div style="${STYLE}">${inner}</div></body></html>`;
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

/** Convert an HTML email into readable text, keeping links and list structure. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text || href.toLowerCase().startsWith("mailto:") || text === href) return text || href;
      return `${text} (${href})`;
    })
    .replace(/<img\b[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, "[$1]")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<\/(p|div|tr|table|ul|ol|h[1-6]|blockquote|section|article)>/gi, "\n")
    .replace(/<(p|h[1-6]|blockquote|ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
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
