import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n/useI18n";

/** Fences, headings, lists, quotes, tables, emphasis, inline code or links. */
const MARKDOWN =
  /^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.*\|\s*$)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m;

function isMarkdown(text: string) {
  return MARKDOWN.test(text);
}

/** A reply's text: rendered when it's Markdown, as written otherwise, with a button to copy it. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="bubble-wrap">
      {isMarkdown(text) ? (
        <div className="bubble markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer" />
              ),
            }}
          >
            {text}
          </Markdown>
        </div>
      ) : (
        <div className="bubble">{text}</div>
      )}
      <CopyButton text={text} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard denied (e.g. insecure context): nothing to show.
    }
  }

  const label = copied ? t("chat.copied") : t("chat.copy");
  return (
    <button
      type="button"
      className="icon copy"
      aria-label={label}
      title={label}
      onClick={() => void copy()}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        {copied ? (
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
          </g>
        )}
      </svg>
    </button>
  );
}
