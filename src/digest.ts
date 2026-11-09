// Recognising a finished digest in the model's reply. Pure, so tests cover it.

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
