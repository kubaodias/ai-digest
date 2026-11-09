# Specs and decisions

Design specs and the decisions behind ai-digest, in the order they were made. Each record says what was decided, why, what else was considered, and what it costs. They're history: when a later decision changes an earlier one, the earlier record says so at the top and stays.

| # | Record | Status | Since |
|---|---|---|---|
| 0001 | [Own entry point and a versioned API](0001-own-entry-point-and-v1-api.md) | accepted | 0.2.0 |
| 0002 | [Deterministic email delivery](0002-deterministic-email-delivery.md) | accepted | 0.1.0 |
| 0003 | [Digests defined in files, stored on the function](0003-digest-definitions.md) | accepted | 0.2.0 |
| 0004 | [Feedback and preferences](0004-feedback-and-preferences.md) | accepted | 0.1.0, revised 0.2.0 and 0.4.0 |
| 0005 | [Agent Memory as a secondary, readable view](0005-agent-memory.md) | accepted | 0.1.0 |
| 0006 | [Pictures from the source articles, judged by a vision model](0006-pictures.md) | accepted | 0.1.0 |
| 0007 | [Security: operator token, signed links, no actor front doors](0007-security.md) | accepted | 0.1.1, 0.1.2, 0.2.0, 0.3.0 |
| 0008 | [Public URL, TLS and custom domains](0008-public-url-and-custom-domains.md) | accepted | 0.3.0, 0.4.2 |
| 0009 | [One-off General digest and preferences shared between digests](0009-general-digest-and-shared-preferences.md) | accepted | 0.4.0 |
| 0010 | [Continuous scouting](0010-continuous-scouting.md) | proposed | (0.5.0) |

Also: [Telnyx platform notes](telnyx-platform-notes.md), what we learned about the platform while building this, with workarounds.

## Format

```
# NNNN. Title
Status: proposed | accepted | superseded by NNNN · Since: version
## Context      what forced a decision
## Decision     what we do
## Alternatives what else was considered, and why not
## Consequences what it costs, what it enables, what to watch
```

A new record takes the next number. Specs for features not built yet start as `proposed` and become `accepted` in the release that ships them.
