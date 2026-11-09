# 0006. Pictures from the source articles, judged by a vision model

Status: accepted · Since: 0.1.0

## Context

Text-only digests are hard to scan, and many stories have a figure that explains them better than a sentence (a benchmark chart, an architecture diagram, a product screenshot). But most images on a news page are noise: logos, stock photos, author portraits, social cards with the headline as text. Asking the research model to pick images added work to its budget and produced decorative choices.

## Decision

- **Pictures are picked in code after the digest is written** (`src/images.ts`), during email delivery (0002), never by the research model.
- For each item: fetch the article (HN threads are followed to the story), collect candidates from the article body, best first (captioned or well-described figures, then in-body images, the `og:image` last), at most 6.
- **A vision model** (`Qwen/Qwen3.8-27B`, with reasoning off) scores each candidate for *this digest's reader* (the first sentence of the digest's description) and says what kind it is; only score ≥ 7 is kept, at most 2 per item.
- Practical rules found along the way: SVG diagrams are converted to PNG where the host supports it; GitHub attachment URLs are rewritten to permanent ones (signed ones expire); a byte floor of 1.5 KB (higher rejected real diagrams); a total time budget, so pictures never delay an email much and never block it.
- `images: off` in a digest's definition turns pictures off.

## Alternatives

- **Always the `og:image`.** Mostly social cards and logos.
- **The research model picks images.** Costs research budget; chooses for looks, not information.
- **No pictures.** Loses real explanatory value for technical stories.

## Consequences

- About a third to a half of items get a picture; the rest stay text, which is fine.
- The vision model's reasoning budget initially consumed the whole token limit and returned empty answers; `reasoning_effort: "none"` fixed it.
- Continuous scouting (0010) keeps this step at send time only: passes never fetch images.
