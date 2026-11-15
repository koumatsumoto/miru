import { Marked } from "marked";
const markdown = new Marked({
  gfm: true,
  renderer: {
    checkbox({ checked }) {
      return `<span class="task-check" role="img" aria-label="${checked ? "完了" : "未完了"}">${checked ? "☑" : "☐"}</span> `;
    },
  },
});

// Parsing is not sanitization: the caller must still use the isolated markup pipeline.
export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false });
}
