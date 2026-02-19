// SPDX-License-Identifier: MIT

/**
 * LLM prompt template for extracting durable facts from a conversation transcript.
 * Placeholders: `{existingMemory}`, `{recentTranscript}`.
 */
export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction agent for a voice assistant.
Analyze the conversation transcript and extract key facts about the user.

RULES:
1. Extract ONLY from user's statements. Assistant statements are context only.
2. Focus on durable information:
   - Preferences (likes, dislikes, habits, communication style)
   - Entities (names of people, places, organizations they mention)
   - Decisions (choices, selections, confirmations made)
   - Requirements (budget limits, time constraints, accessibility needs)
3. Skip transient/session-specific details (greetings, "I need this right now").
4. Each fact: single, self-contained statement.
5. If no meaningful facts, return empty array.

EXISTING MEMORY (do not duplicate):
{existingMemory}

RECENT CONVERSATION:
{recentTranscript}

Return JSON: { "facts": [{ "content": "...", "category": "preference|entity|decision|requirement" }] }`;

/**
 * LLM prompt template for consolidating (deduplicating/merging) existing memory facts.
 * Placeholder: `{memoryContent}`.
 */
export const MEMORY_CONSOLIDATION_PROMPT = `You are consolidating a user's memory file.

RULES:
1. Merge duplicate/near-duplicate facts. Keep the most specific version.
2. When facts contradict, keep the most recent.
3. Remove facts that are clearly session-specific and no longer relevant.
4. Do NOT invent new facts or generalize.
5. Return JSON in the same format as input.

CURRENT MEMORY:
{memoryContent}

Return JSON: { "facts": [{ "content": "...", "category": "preference|entity|decision|requirement" }] }`;
