import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("regression #9221: reload during an active tool", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	function createBlockingTool() {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		let releaseTool = () => {};
		const toolReleased = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Waits until released, then succeeds",
			parameters: Type.Object({}),
			execute: () =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					markToolStarted();
					toolReleased.then(() =>
						resolve({ content: [{ type: "text", text: "tool succeeded" }], details: {} }),
					);
				}),
		};
		return { tool, toolStarted, releaseTool };
	}

	it("rejects reload while a tool is running and preserves the successful tool result", async () => {
		const { tool, toolStarted, releaseTool } = createBlockingTool();
		const harness = await createHarness({ tools: [tool] });
		cleanups.push(async () => harness.cleanup());

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const outgoingPrompt = harness.session.prompt("start blocking tool");
		await toolStarted;

		await expect(harness.session.reload()).rejects.toThrow(
			"Wait for the current response to finish before reloading.",
		);

		releaseTool();
		await outgoingPrompt;

		const stored = JSON.stringify(harness.session.messages);
		expect(stored).toContain("tool succeeded");
		expect(stored).not.toContain("stale after session replacement");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect((toolResult as { isError?: boolean }).isError).not.toBe(true);

		let capturedContext = "";
		harness.setResponses([
			(context) => {
				capturedContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("next prompt");

		expect(capturedContext).toContain("tool succeeded");
		expect(capturedContext).not.toContain("stale after session replacement");
	});

	it("allows reload when the session is idle", async () => {
		const harness = await createHarness();
		cleanups.push(async () => harness.cleanup());

		harness.setResponses([fauxAssistantMessage("first response")]);
		await harness.session.prompt("first prompt");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);

		await expect(harness.session.reload()).resolves.toBeUndefined();

		harness.setResponses([fauxAssistantMessage("after reload")]);
		await harness.session.prompt("after reload");
		const assistantTexts = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message));
		expect(assistantTexts.join("\n")).toContain("after reload");
	});
});
