/*---------------------------------------------------------------------------------------------
 *  Local contract (NOT a VS Code proposal — no vscode-dts exists for this).
 *
 *  Token usage reporting for language-model providers. A provider reports the
 *  final usage of a request by reporting a `LanguageModelDataPart` whose
 *  mimeType is `usage` and whose data is the JSON-serialized `APIUsage` shape
 *  below. This is the same mechanism Copilot's built-in BYOK providers use
 *  (see microsoft/vscode `extensions/copilot/src/extension/byok/*` and
 *  `extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts`,
 *  which parses the part via `isApiUsage()`).
 *
 *  Validation requirements (extChatEndpoint.ts / openai.ts `isApiUsage`):
 *  `prompt_tokens`, `completion_tokens` and `total_tokens` MUST be numbers,
 *  otherwise the part is ignored.
 *
 *  Copilot's agent loop forwards parsed usage to the chat UI context-usage
 *  widget (toolCallingLoop.ts → stream.usage()). `prompt_tokens_details`
 *  and `completion_tokens_details` are consumed for the cached/reasoning
 *  breakdown (AgentHostByokLmHandler._decodeUsage, OTel GenAI attributes).
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI-style usage payload carried in a `LanguageModelDataPart` with
 * mimeType `'usage'`.
 */
export interface LanguageModelUsagePayload {
	/** Number of prompt (input) tokens. Required for the part to be accepted. */
	prompt_tokens: number;
	/** Number of completion (output) tokens. Required for the part to be accepted. */
	completion_tokens: number;
	/** Total tokens (prompt + completion). Required for the part to be accepted. */
	total_tokens: number;
	/** Optional breakdown of prompt tokens. */
	prompt_tokens_details?: {
		/** Number of prompt tokens served from the provider's prompt cache. */
		cached_tokens?: number;
	};
	/** Optional breakdown of completion tokens. */
	completion_tokens_details?: {
		/** Number of completion tokens used for reasoning/thinking output. */
		reasoning_tokens?: number;
	};
}

/**
 * Builds a valid usage DataPart payload, omitting empty detail sections and
 * enforcing the numeric fields required by `isApiUsage`.
 */
export function buildUsagePayload(usage: {
	prompt: number;
	completion: number;
	cached?: number;
	reasoning?: number;
}): LanguageModelUsagePayload {
	return {
		prompt_tokens: usage.prompt,
		completion_tokens: usage.completion,
		total_tokens: usage.prompt + usage.completion,
		...(usage.cached !== undefined
			? { prompt_tokens_details: { cached_tokens: usage.cached } }
			: {}),
		...(usage.reasoning !== undefined
			? { completion_tokens_details: { reasoning_tokens: usage.reasoning } }
			: {}),
	};
}
