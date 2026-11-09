// The built-in General digest's definition: a template for one-off digests on
// any topic (`ai-digest ask "<topic>"`, POST /v1/runs). Same format as
// a digest file (profile.ts). {topic} is filled in after parsing, in the title
// and the description only; {range} is the dates covered, as in any title.
// Edit the wording here; the defaults (window, items) can be overridden per run.
export const GENERAL_TEMPLATE = String.raw`---
title: "{topic} — {range}"
window: 7d
items: 5-10
closing: Takeaways
---
The reader would like to get information about {topic}: the most relevant recent news, releases, research, tools and practical developments, with why each one matters.

Search the topic directly and look for primary sources (the maker's own posts, release notes, papers, repositories, issue trackers) and the communities that discuss it. Leave out items only loosely related to {topic}, generic overviews, listicles and marketing posts without substance.
`;
