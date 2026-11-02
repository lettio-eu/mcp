import assert from "node:assert/strict";
import { test } from "node:test";
import { base64ToBytes, bytesToBase64, htmlToText, markdownToHtml } from "../src/core/format.js";

test("markdown becomes formatted html", () => {
  const html = markdownToHtml("# Hi\n\n**bold**\n\n- a\n- b\n\n| x |\n|---|\n| 1 |");
  for (const tag of ["<h1>", "<strong>", "<li>", "<table>"]) assert.ok(html.includes(tag), tag);
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

test("base64 round-trips binary", () => {
  const b = new Uint8Array(100000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
});
