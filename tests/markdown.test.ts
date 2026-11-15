import { expect, it } from "vite-plus/test";
import { renderMarkdown } from "../src/web/markdown";
it("renders GFM tables, deletion and fenced code without interpreting code HTML", () => {
  const html = renderMarkdown(
    "| A | B |\n| --- | --- |\n| One | Two |\n\n~~old~~\n\n```html\n<script>alert(1)</script>\n```",
  );
  expect(html).toContain("<table>");
  expect(html).toContain("<del>old</del>");
  expect(html).toContain('class="language-html"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
it("renders task list checkmarks as non-interactive accessible text", () => {
  const html = renderMarkdown("- [x] Done\n- [ ] Pending");
  expect(html).toContain('aria-label="完了"');
  expect(html).toContain('aria-label="未完了"');
  expect(html).toContain("☑");
  expect(html).toContain("☐");
  expect(html).not.toContain("<input");
});
