import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent";

const render = (content: string) => renderToStaticMarkup(createElement(MessageContent, { content, rich: true }));

describe("MessageContent", () => {
  it("renders a Markdown table, keeping an escaped pipe inside its cell", () => {
    const html = render("| guard | outcome |\n| --- | --- |\n| off | `a\\|b` |\n| egress | – |");
    expect(html).toContain("<th>guard</th>");
    expect(html).toContain("<td>off</td><td><code>a|b</code></td>");
    expect(html).toContain("<td>egress</td><td>–</td>");
    expect(html).not.toContain("---");
  });

  it("leaves a line with pipes as text when no divider follows it", () => {
    expect(render("| not a table |\nnext line")).toBe('<div class="message-body message-body-rich"><p>| not a table | next line</p></div>');
  });

  it("renders a quote without its marker", () => {
    expect(render("> Small **slice**")).toContain("<blockquote>Small <strong>slice</strong></blockquote>");
  });
});
