import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

const isTauri = "__TAURI_INTERNALS__" in window;

export function MarkdownMessage({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children: label }) => <a href={href} onClick={(event) => {
            if (isTauri && href) {
              event.preventDefault();
              void openUrl(href);
            }
          }} target="_blank" rel="noreferrer">{label}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
