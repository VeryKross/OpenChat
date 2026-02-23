import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HELP_TOPICS, type HelpTopicId } from "../help/topics";

interface HelpCenterProps {
  activeTopicId: HelpTopicId;
  onSelectTopic: (topicId: HelpTopicId) => void;
  onClose: () => void;
}

interface RenderedArticle {
  nodes: ReactNode[];
  headings: Array<{ id: string; text: string; level: number }>;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null = tokenPattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-token-${tokenIndex}`;
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key} className="help-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        const isExternal = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noreferrer" : undefined}
          >
            {label}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
    tokenIndex += 1;
    match = tokenPattern.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isListBullet(line: string) {
  return /^\s*-\s+/.test(line);
}

function isListNumber(line: string) {
  return /^\s*\d+\.\s+/.test(line);
}

function renderMarkdown(markdown: string): RenderedArticle {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  const headings: Array<{ id: string; text: string; level: number }> = [];
  const headingIdCounts = new Map<string, number>();
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(
        <pre key={`code-${blockIndex}`} className="help-code-block">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      blockIndex += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1].length);
      const text = headingMatch[2].trim();
      const base = slugify(text) || `section-${headings.length + 1}`;
      const count = headingIdCounts.get(base) ?? 0;
      headingIdCounts.set(base, count + 1);
      const id = count > 0 ? `${base}-${count + 1}` : base;
      headings.push({ id, text, level });
      const HeadingTag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      nodes.push(
        <HeadingTag key={`heading-${blockIndex}`} id={id}>
          {renderInline(text, `heading-inline-${blockIndex}`)}
        </HeadingTag>
      );
      i += 1;
      blockIndex += 1;
      continue;
    }

    if (isListBullet(trimmed)) {
      const items: ReactNode[] = [];
      let itemIndex = 0;
      while (i < lines.length && isListBullet(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\-\s+/, "");
        items.push(<li key={`ul-item-${blockIndex}-${itemIndex}`}>{renderInline(itemText, `ul-inline-${blockIndex}-${itemIndex}`)}</li>);
        i += 1;
        itemIndex += 1;
      }
      nodes.push(
        <ul key={`ul-${blockIndex}`} className="help-list">
          {items}
        </ul>
      );
      blockIndex += 1;
      continue;
    }

    if (isListNumber(trimmed)) {
      const items: ReactNode[] = [];
      let itemIndex = 0;
      while (i < lines.length && isListNumber(lines[i].trim())) {
        const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
        items.push(<li key={`ol-item-${blockIndex}-${itemIndex}`}>{renderInline(itemText, `ol-inline-${blockIndex}-${itemIndex}`)}</li>);
        i += 1;
        itemIndex += 1;
      }
      nodes.push(
        <ol key={`ol-${blockIndex}`} className="help-list">
          {items}
        </ol>
      );
      blockIndex += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !isListBullet(lines[i].trim()) &&
      !isListNumber(lines[i].trim())
    ) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }
    const paragraphText = paragraphLines.join(" ");
    nodes.push(
      <p key={`p-${blockIndex}`} className="help-paragraph">
        {renderInline(paragraphText, `p-inline-${blockIndex}`)}
      </p>
    );
    blockIndex += 1;
  }

  return { nodes, headings };
}

export function HelpCenter({ activeTopicId, onSelectTopic, onClose }: HelpCenterProps) {
  const [filter, setFilter] = useState("");
  const articleRef = useRef<HTMLDivElement>(null);
  const normalizedFilter = filter.trim().toLowerCase();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredTopics = useMemo(() => {
    if (!normalizedFilter) return HELP_TOPICS;
    return HELP_TOPICS.filter((topic) =>
      `${topic.title} ${topic.summary} ${topic.markdown}`.toLowerCase().includes(normalizedFilter)
    );
  }, [normalizedFilter]);

  const activeTopic =
    HELP_TOPICS.find((topic) => topic.id === activeTopicId) ??
    HELP_TOPICS.find((topic) => topic.id === filteredTopics[0]?.id) ??
    HELP_TOPICS[0];

  const article = useMemo(() => renderMarkdown(activeTopic.markdown), [activeTopic]);

  const topicsBySection = useMemo(() => {
    const groups = new Map<string, typeof HELP_TOPICS>();
    for (const topic of filteredTopics) {
      const existing = groups.get(topic.section) ?? [];
      groups.set(topic.section, [...existing, topic]);
    }
    return Array.from(groups.entries());
  }, [filteredTopics]);

  return (
    <div className="tool-popup-backdrop" onClick={onClose}>
      <div className="tool-popup help-center-modal" onClick={(event) => event.stopPropagation()}>
        <div className="tool-popup-header">
          <div className="tool-popup-title">Help Center</div>
          <button type="button" className="tool-popup-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="help-center-layout">
          <aside className="help-sidebar">
            <input
              className="help-topic-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search help topics"
            />
            {topicsBySection.length === 0 ? (
              <p className="status-text">No help topics match your filter.</p>
            ) : (
              topicsBySection.map(([section, topics]) => (
                <div key={section} className="help-topic-section">
                  <div className="help-topic-section-label">{section}</div>
                  {topics.map((topic) => (
                    <button
                      key={topic.id}
                      type="button"
                      className={`help-topic-btn ${topic.id === activeTopic.id ? "active" : ""}`}
                      onClick={() => onSelectTopic(topic.id)}
                    >
                      <span className="help-topic-title">{topic.title}</span>
                      <span className="help-topic-summary">{topic.summary}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </aside>
          <section className="help-article" ref={articleRef}>
            <div className="help-article-header">
              <h2>{activeTopic.title}</h2>
              <p className="status-text">{activeTopic.summary}</p>
            </div>
            {article.headings.length > 1 && (
              <div className="help-anchor-list">
                {article.headings
                  .filter((heading) => heading.level >= 2)
                  .map((heading) => (
                    <button
                      key={heading.id}
                      type="button"
                      className={`help-anchor-btn help-anchor-level-${heading.level}`}
                      onClick={() => {
                        const target = articleRef.current?.querySelector(`#${heading.id}`);
                        if (target instanceof HTMLElement) {
                          target.scrollIntoView({ behavior: "smooth", block: "start" });
                        }
                      }}
                    >
                      {heading.text}
                    </button>
                  ))}
              </div>
            )}
            <article className="help-markdown">{article.nodes}</article>
          </section>
        </div>
      </div>
    </div>
  );
}
