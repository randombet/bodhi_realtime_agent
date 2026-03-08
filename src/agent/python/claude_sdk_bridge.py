#!/usr/bin/env python3
import asyncio
import json
import sys

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import AssistantMessage, ResultMessage, TextBlock


async def run(payload: dict):
    cfg = payload.get("config", {})
    options = ClaudeAgentOptions(
        system_prompt=(
            payload.get("subagentInstructions", "")
            + "\n\nYou must return strict JSON matching this schema:"
            + '{"status":"completed|needs_input","message":"string","question":"string|null"}'
            + "\nUse status=needs_input only if user input is required before you can continue."
        ),
        model=cfg.get("model"),
        permission_mode=cfg.get("permissionMode"),
        allowed_tools=cfg.get("allowedTools", []),
        max_turns=cfg.get("maxTurns"),
        cwd=cfg.get("cwd"),
        continue_conversation=bool(payload.get("sessionId")),
        resume=payload.get("sessionId"),
        output_format={
            "type": "json_schema",
            "name": "subagent_response",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "status": {"type": "string", "enum": ["completed", "needs_input"]},
                    "message": {"type": "string"},
                    "question": {"type": ["string", "null"]},
                },
                "required": ["status", "message", "question"],
            },
        },
    )

    assistant_text = ""
    session_id = payload.get("sessionId")
    structured_output = None

    async for message in query(prompt=payload["prompt"], options=options):
        if isinstance(message, AssistantMessage):
            text_parts = [block.text for block in message.content if isinstance(block, TextBlock)]
            if text_parts:
                assistant_text = "\n".join(text_parts)
        elif isinstance(message, ResultMessage):
            session_id = message.session_id
            if message.structured_output is not None:
                structured_output = message.structured_output
            elif message.result:
                try:
                    structured_output = json.loads(message.result)
                except Exception:
                    pass

    return {
        "sessionId": session_id,
        "assistantText": assistant_text,
        "structuredOutput": structured_output,
        "isError": False,
    }


def main():
    try:
        payload = json.loads(sys.argv[1])
    except Exception as exc:
        print(json.dumps({"isError": True, "error": f"invalid payload: {exc}"}))
        sys.exit(1)

    try:
        result = asyncio.run(run(payload))
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"isError": True, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
