import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

const anyOfTool: Tool = {
	name: "set_mode",
	description: "Set the operation mode",
	parameters: Type.Union([
		Type.Object({ mode: Type.Literal("fast") }, { additionalProperties: false }),
		Type.Object({ mode: Type.Literal("custom"), value: Type.String() }, { additionalProperties: false }),
	]),
};

const objectTool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

function createContext(tools: Tool[]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		tools,
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureRequest(context: Context): Promise<Record<string, unknown>> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest.body;
}

function getToolInputSchema(body: Record<string, unknown>, name: string): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools)) throw new Error("Expected tools in request body");
	const tool = tools.find(
		(entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).name === name,
	);
	if (typeof tool !== "object" || tool === null) throw new Error(`Expected tool "${name}" in request body`);
	const inputSchema = (tool as Record<string, unknown>).input_schema;
	if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
		throw new Error(`Expected input_schema for tool "${name}"`);
	}
	return inputSchema as Record<string, unknown>;
}

describe("Anthropic tool input schema preservation", () => {
	it("keeps a root-level anyOf in the model-facing input_schema for non-strict tools", async () => {
		const body = await captureRequest(createContext([anyOfTool]));
		const inputSchema = getToolInputSchema(body, "set_mode");

		expect(Array.isArray(inputSchema.anyOf)).toBe(true);
		expect((inputSchema.anyOf as unknown[]).length).toBe(2);
		expect(inputSchema.type).toBe("object");
	});

	it("keeps the legacy object shape for plain object schemas", async () => {
		const body = await captureRequest(createContext([objectTool]));
		const inputSchema = getToolInputSchema(body, "lookup");

		expect(inputSchema.type).toBe("object");
		expect(inputSchema.properties).toBeDefined();
		expect(Array.isArray(inputSchema.required)).toBe(true);
	});
});
