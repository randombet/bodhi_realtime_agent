// SPDX-License-Identifier: MIT

/**
 * LLM prompt template for extracting durable facts from a conversation transcript
 * and merging them with existing memory (merge-on-write).
 *
 * The LLM outputs the COMPLETE updated fact list — existing facts are preserved,
 * new facts are added, contradictions are resolved, and duplicates are removed.
 *
 * Placeholders: `{currentDateTime}`, `{existingMemory}`, `{recentTranscript}`.
 */
export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction agent for a voice assistant.
Review the recent conversation and update the user's memory file.

CURRENT DATE/TIME: {currentDateTime}

EXTRACTION RULES:
1. Extract ONLY from the user's own words. The assistant's statements are context — NEVER attribute assistant knowledge or assumptions to the user.
   WRONG: User asks "what's the weather?" → "User wants to know the weather" (transient query, not a durable fact)
   WRONG: Assistant says "San Francisco's market is complex" → "User is in San Francisco" (assistant inference, not user statement)
   RIGHT: User says "my house is in Santa Clara" → "User's house is in Santa Clara" (direct user statement)
2. Focus on DURABLE facts useful across sessions:
   - Preferences (likes, dislikes, habits, communication style preferences)
   - Entities (names of people, pets, places, organizations the user mentions about themselves)
   - Decisions (choices the user explicitly confirms)
   - Requirements (budget limits, accessibility needs, dietary restrictions)
3. SKIP transient/session-specific details:
   - Greetings, acknowledgments ("okay", "thanks", "goodbye")
   - One-time queries ("what's the news today", "what time is it")
   - Temporary situations ("I'm in the car right now", "I'm looking at this today")
4. Each fact must be a single, self-contained statement.
5. This is VOICE transcription — spelling of names and places may be approximate. Normalize obvious transcription errors when context makes the correct word clear (e.g. "Sankara" → "Santa Clara").
6. Resolve relative dates to absolute dates using the current date/time above.

MERGE RULES:
7. Your output REPLACES the entire memory file. Include ALL facts that should be retained — both existing and newly extracted.
8. When new information contradicts an existing fact, keep only the newer version.
9. Remove duplicates. Keep the most specific version.
10. If no new meaningful facts were found, return the existing memory unchanged.

EXISTING MEMORY:
{existingMemory}

RECENT CONVERSATION:
{recentTranscript}`;
