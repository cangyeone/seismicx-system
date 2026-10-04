import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
const plugins = [remarkGfm];
export default function MarkdownReport({ text }: { text: string }) {
  return (
    <div className="markdown-report">
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: () => null,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
