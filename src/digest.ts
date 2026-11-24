// Recognising a finished digest in the model's reply, and finding its numbered items. Pure, so tests cover it.

/** The digest to email, when the reply is one (numbered "## N." items); undefined for answers, errors or questions. */
export function digestFromReply(reply: string): { subject: string; markdown: string } | undefined {
  const markdown = sourceLabels(reply.trim());
  if (!/^##\s+\d+\.\s+\S/m.test(markdown)) return undefined;
  const subject = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? "AI & Software Engineering Digest").trim();
  return { subject, markdown };
}

/** "**Source:**" before several links reads "**Sources:**", and one link the other way round. */
export function sourceLabels(markdown: string): string {
  return markdown.replace(/^(\s*)\*\*Sources?:\*\*(.*)$/gm, (_, lead: string, rest: string) => {
    const links = rest.match(/\]\(https?:\/\//g)?.length ?? 0;
    return `${lead}**${links > 1 ? "Sources" : "Source"}:**${rest}`;
  });
}

/** A numbered item in a digest's Markdown: where it is, its headline, its "Why it matters" text and its links. */
export interface Section {
  start: number;
  end: number;
  headline: string;
  context: string;
  links: string[];
}

/** The digest's numbered items ("## 1. …"), each with its headline, "Why it matters" text and links in order. */
export function digestSections(markdown: string): Section[] {
  const heads = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)$/gm)];
  return heads.map((h, i) => {
    const start = h.index!;
    const nextHeading = markdown.slice(start + h[0].length).search(/^##\s/m);
    const end = nextHeading === -1 ? markdown.length : start + h[0].length + nextHeading;
    const block = markdown.slice(start, end);
    const context = block.match(/\*\*Why it matters:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    const links = [...block.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!).filter((u) => !/reddit\.com|lobste\.rs|x\.com|twitter\.com|news\.ycombinator\.com\/(?!item)/i.test(u));
    return { start, end, headline: h[1]!.trim(), context, links };
  });
}
