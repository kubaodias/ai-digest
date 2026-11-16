// The voice assistant for talking about an issue (src/talk.ts): created or
// updated by `ai-digest deploy`, found by its name. Its tools are client-side:
// the talk page answers them with the link's signed token.

import { telnyx } from "./lib.mjs";
import { DEFAULT_GREETING, TALK_ASSISTANT_NAME, TALK_INSTRUCTIONS } from "../src/talk-instructions.ts";

/** A Telnyx stock voice; set TALK_VOICE in .env to use another (Provider.Model.Voice). */
const DEFAULT_VOICE = "Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02";
const MODEL = "zai-org/GLM-5.3-Flash";

const story = { type: "integer", description: "The story's number from get_issue (never say it aloud)." };
const clientTool = (name, description, properties = {}, required = []) => ({
  type: "client_side_tool",
  client_side_tool: { name, description, parameters: { type: "object", properties, required } },
});

export function assistantConfig(env) {
  return {
    name: TALK_ASSISTANT_NAME,
    description: "Talks with a reader about an AI Digest issue, in the browser (ai-digest).",
    model: MODEL,
    instructions: TALK_INSTRUCTIONS,
    // X-Greeting and X-Digest headers from the talk page become these variables.
    greeting: "{{greeting}}",
    dynamic_variables: { greeting: DEFAULT_GREETING, digest: "your digest" },
    voice_settings: { voice: env.TALK_VOICE || DEFAULT_VOICE },
    transcription: { model: "deepgram/flux", language: "en" },
    enabled_features: ["telephony"],
    telephony_settings: { supports_unauthenticated_web_calls: true, time_limit_secs: 1200, user_idle_timeout_secs: 120 },
    tools: [
      { type: "hangup", hangup: { description: "Hang up after saying goodbye, when the listener is done." } },
      clientTool("get_issue", "The issue being discussed: digest name, day, and its stories in order (number, headline, summary, source); start_with when the listener came from one story's link. Instant."),
      clientTool("show_story", "Show the story you're now talking about on the listener's screen. Call it (silently, it's instant) whenever you move to a story.", { story }, ["story"]),
      clientTool("read_article", "Read a story's full article and get notes to discuss it from. Takes a few seconds: say you're reading it first.", {
        story,
        focus: { type: "string", description: "The listener's question about the article, if any." },
      }, ["story"]),
      clientTool("search_web", "Search the web for questions the article doesn't answer (comparisons, background, other coverage). Returns titles, sources and excerpts.", {
        query: { type: "string", description: "A specific search query." },
      }, ["query"]),
      clientTool("record_vote", "Record the listener's feedback on a story: up when they liked it or want more like it, down when they don't care or don't use the product.", {
        story,
        vote: { type: "string", enum: ["up", "down"] },
      }, ["story", "vote"]),
    ],
  };
}

/** Create the assistant, or update the one with our name; returns its id. */
export async function ensureTalkAssistant(env) {
  const list = await telnyx(env, "GET", "/ai/assistants");
  const found = (list.data ?? []).find((a) => a.name === TALK_ASSISTANT_NAME);
  const config = assistantConfig(env);
  if (found) {
    await telnyx(env, "POST", `/ai/assistants/${found.id}`, config);
    return { id: found.id, created: false };
  }
  const created = await telnyx(env, "POST", "/ai/assistants", config);
  return { id: created.id ?? created.data?.id, created: true };
}
