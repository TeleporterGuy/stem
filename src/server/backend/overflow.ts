// Provider context-overflow error shapes (a trimmed copy of pi's own detection
// list). pi handles these with compact-and-retry internally, but that recovery
// has been observed to fail silently, so Stem self-heals too: the scheduler
// condenses-and-retries a failed scheduled run, and the runtime condenses the
// thread after an interactive turn dies on one (see TaskScheduler.runTask and
// PiRuntime.settleTurn).
const OVERFLOW_PATTERNS = [
  /exceeds the context window/i, // OpenAI
  /prompt is too long/i, // Anthropic (token overflow)
  /request_too_large/i, // Anthropic (request byte-size overflow, HTTP 413)
  /maximum context length/i, // OpenAI-compatible proxies / OpenRouter
  /input token count.*exceeds the maximum/i, // Google
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /context[_ ]length[_ ]exceeded/i, // generic
  /token limit exceeded/i // generic
];

/** True when a turn's terminal error reads as a provider context overflow. */
export function isContextOverflowError(message: string | undefined): boolean {
  if (!message) return false;
  if (/rate limit|too many requests/i.test(message)) return false;
  return OVERFLOW_PATTERNS.some((p) => p.test(message));
}
