import assert from "node:assert/strict";
import { test } from "node:test";
import { base64ToBytes, bytesToBase64, darkLinkColor, htmlToText, markdownToHtml, renderEmail } from "../src/core/format.js";

test("markdown becomes formatted html", () => {
  const html = markdownToHtml("# Hi\n\n**bold**\n\n- a\n- b\n\n| x |\n|---|\n| 1 |");
  for (const tag of ["<h1 ", "<strong ", "<li ", "<table "]) assert.ok(html.includes(tag), tag);
});

test("raw html is escaped, not rendered", () => {
  const html = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=y>');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
});

test("unsafe links lose their href", () => {
  assert.ok(!markdownToHtml("[x](javascript:alert(1))").includes("javascript:"));
  assert.ok(markdownToHtml("[x](https://lettio.eu)").includes('href="https://lettio.eu"'));
});

test("html converts to readable text", () => {
  const t = htmlToText(
    '<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>you</b></p><ul><li>One</li></ul><a href="https://a.eu">site</a><script>x</script></body></html>',
  );
  assert.equal(t, "Hello you\n\n- One\n\nsite (https://a.eu)");
});

test("lists and tables stay readable as text", () => {
  const t = htmlToText(markdownToHtml("- a\n- b\n\n1. one\n2. two\n\n| Name | State |\n|---|---|\n| Mail | done |\n| Files | later |"));
  assert.equal(t, "- a\n- b\n\n1. one\n2. two\n\nName | State\nMail | done\nFiles | later");
});

test("layout tables don't leave stray separators", () => {
  assert.equal(htmlToText("<table><tr><td></td><td></td></tr><tr><td>Hi</td></tr></table>"), "Hi");
});

test("nested lists keep their numbering", () => {
  const t = htmlToText("<ol><li>a<ol><li>x</li></ol></li><li>b</li></ol>");
  assert.ok(t.includes("1. x") && t.includes("2. b"), t);
});

test("rich blocks render and read back as text", () => {
  const md = "> Quote line\n>\n> — Jana\n\n> [!NOTE] Heads up\n> Price holds.\n\n[Approve](https://valmia.cz \"button\")\n\n```\ndig MX x\n```";
  const html = renderEmail(md, { primary: "#231F47", accent: "#D8093A" }, "<b>Martin</b>");
  for (const s of ["#D8093A", "Heads up", ">Approve</a>", "dig MX x", "<b>Martin</b>"]) assert.ok(html.includes(s), s);
  assert.equal(htmlToText(html), "Quote line\n\nJana\n\nHeads up\n\nPrice holds.\n\nApprove (https://valmia.cz)\n\ndig MX x\n\nMartin");
});

test("base64 round-trips binary", () => {
  const b = new Uint8Array(100000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
});

test("mail switches to light text in dark mode", () => {
  const html = renderEmail("# Hi\n\nText\n\n`x`", { primary: "#231F47", accent: "#D8093A" });
  assert.ok(html.includes("@media (prefers-color-scheme:dark){"));
  assert.ok(/\.lt-mail p[^}]*\{color:#e8e8ee!important\}/.test(html));
  assert.ok(html.includes('class="lt-mail"') && html.includes('class="lt-soft"'));
  assert.equal(htmlToText(html), "Hi\n\nText\n\nx");
});

test("dark mode darkens the whole canvas and lightens links to readable", () => {
  const html = renderEmail("[site](https://lettio.eu)\n\nText", { primary: "#231F47", accent: "#005c3d" });
  const dark = html.slice(html.indexOf("@media (prefers-color-scheme:dark)"), html.indexOf("</style>"));
  assert.ok(dark.includes("html,body,.lt-mail{background:#1f1f22!important}"), dark);
  assert.ok(!dark.includes("border-radius"), "no card look");
  const link = darkLinkColor("#005c3d");
  assert.ok(dark.includes(`.lt-mail a.lt-link{color:${link}!important}`));
  assert.notEqual(link, "#005c3d");
  assert.ok(html.includes('class="lt-link"'));
  // Outside the dark query the mail keeps no background of its own.
  const body = html.slice(html.indexOf("<body"));
  assert.ok(!/class="lt-mail" style="[^"]*background/.test(body));
});

test("darkLinkColor keeps an already light accent and falls back for bad input", () => {
  assert.equal(darkLinkColor("#9ecbff"), "#9ecbff");
  assert.equal(darkLinkColor("not-a-colour"), "#9ecbff");
});

test("text carries no colour unless the brand sets one", () => {
  const html = renderEmail("# Hi\n\nText\n\n| a |\n|---|\n| 1 |", { primary: "#231F47", accent: "#D8093A" });
  const body = html.slice(html.indexOf("<body"));
  assert.ok(!/[^-]color:#(?!ffffff)/i.test(body.replace(/color:#D8093A/g, "")), body);
  assert.ok(renderEmail("Text", { primary: "#000", accent: "#111", text: "#222" }).includes("color:#222;"));
});
