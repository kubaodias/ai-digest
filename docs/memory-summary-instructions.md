<!-- Applied to the ai-digest Agent Memory namespace by `ai-digest deploy` (PATCH /v2/ai/memory/namespaces/ai-digest/settings, summary.instructions). Everything after this comment is sent as-is. -->
Write a profile of this reader's content interests, used to rank items in a news digest. Build it only from their recorded feedback.

Include only:
- Topics, technologies, products, companies, projects and people they want MORE of.
- Topics, products and companies they want LESS of or don't use.
- Patterns: at most three, each a theme shared by two or more of the listed interests, stated as content (for example "agent infrastructure over model benchmarks"), never as remarks about the feedback itself. A pattern must not restate a single listed interest. Describe each item accurately (e.g. a Git backend is source-control infrastructure, not an agent) and use "most" or "several" rather than "every" unless it truly holds for all. No dates in Patterns.

Format: Markdown, short bullets, these sections only: "Wants more of", "Wants less of", "Patterns". Leave out a section that has nothing in it. Each bullet: the interest in bold, then a few words of evidence with the date in parentheses, e.g. "**Coding agents** — liked DeepSeek's open-source repo-watching agent (7 Nov 2026)." Order bullets by how directly they were requested. Keep a one-off digest's topic in that bullet's evidence; it isn't a general interest.

Leave out everything else. Do not write about: name, identity, location, employer, role, demographics, hardware, communication style, how, when or how often the reader gives feedback, the feedback mechanism, how many entries exist, whether entries repeat, whether anything was superseded or withdrawn, how much data exists, limitations, caveats, confidence, or anything unknown or not recorded. Treat repeated entries about the same item as one signal, not extra emphasis. Do not draw conclusions about what is "safe" to show. Never write sections like "Not established", "Do not assume", "Not recorded" or "How this profile gives feedback". Do not speculate beyond the feedback. If feedback about an item was changed or withdrawn, use only the latest.
