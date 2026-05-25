import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

type Match = {
	path: string;
	line: number;
	preview: string;
};

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_SNIPPET_IN_PROMPT = 8000;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("paste", {
		description: "Find the current clipboard text in the project and use that file/snippet as context; defaults to explain if no instruction is given",
		handler: async (args, ctx) => {
			const rawInstruction = args.trim();
			const instruction = rawInstruction || "explain this";
			const explainByDefault = !rawInstruction;

			const clipboard = await getClipboardText(pi);
			if (!clipboard.trim()) {
				ctx.ui.notify("Clipboard is empty.", "warning");
				return;
			}

			const candidates = buildNeedleCandidates(clipboard);
			let selectedNeedle = "";
			let matches: Match[] = [];

			for (const candidate of candidates) {
				const candidateMatches = await findMatches(ctx.cwd, candidate);
				if (candidateMatches.length > 0) {
					selectedNeedle = candidate;
					matches = candidateMatches;
					break;
				}
			}

			if (matches.length === 0) {
				ctx.ui.notify("No file in the current directory contains the clipboard text.", "warning");
				return;
			}

			const match = await chooseMatch(matches, ctx);
			if (!match) return;

			const relativePath = path.relative(ctx.cwd, match.path) || path.basename(match.path);
			const prompt = buildPrompt({
				instruction,
				explainByDefault,
				relativePath,
				line: match.line,
				needle: selectedNeedle,
				matchCount: matches.length,
			});

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
				ctx.ui.notify(`Using clipboard match in ${relativePath}:${match.line}`, "info");
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify(`Queued /paste for ${relativePath}:${match.line}`, "info");
			}
		},
	});
}

async function getClipboardText(pi: ExtensionAPI): Promise<string> {
	const commands = [
		{ command: "pbpaste", args: [] as string[] },
		{ command: "wl-paste", args: ["-n"] },
		{ command: "xclip", args: ["-selection", "clipboard", "-o"] },
	];

	for (const entry of commands) {
		try {
			const result = await pi.exec(entry.command, entry.args, { timeout: 3000 });
			if (result.code === 0 && result.stdout) return result.stdout;
		} catch {
			// Try the next clipboard command.
		}
	}

	return "";
}

function buildNeedleCandidates(clipboard: string): string[] {
	const values = [
		clipboard,
		normalizeNewlines(clipboard),
		clipboard.trim(),
		normalizeNewlines(clipboard).trim(),
	];

	const seen = new Set<string>();
	const candidates: string[] = [];

	for (const value of values) {
		if (!value || !value.trim() || seen.has(value)) continue;
		seen.add(value);
		candidates.push(value);
	}

	return candidates;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n");
}

async function findMatches(root: string, needle: string): Promise<Match[]> {
	const matches: Match[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(fullPath);
				continue;
			}

			if (!entry.isFile()) continue;

			let stats;
			try {
				stats = await fs.stat(fullPath);
			} catch {
				continue;
			}

			if (stats.size === 0 || stats.size > MAX_FILE_SIZE) continue;

			let buffer: Buffer;
			try {
				buffer = await fs.readFile(fullPath);
			} catch {
				continue;
			}

			if (buffer.includes(0)) continue;

			const content = normalizeNewlines(buffer.toString("utf8"));
			const index = content.indexOf(needle);
			if (index === -1) continue;

			const line = content.slice(0, index).split("\n").length;
			const previewLine = content.slice(index).split("\n", 2)[0].trim();
			matches.push({
				path: fullPath,
				line,
				preview: previewLine,
			});
		}
	}

	await walk(root);
	matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	return matches;
}

async function chooseMatch(matches: Match[], ctx: ExtensionCommandContext): Promise<Match | null> {
	if (matches.length === 1) return matches[0];
	if (!ctx.hasUI) return matches[0];

	const labels = matches.map((match, index) => {
		const rel = path.relative(ctx.cwd, match.path) || path.basename(match.path);
		const preview = match.preview || "(match starts on a blank line)";
		return `${index + 1}. ${rel}:${match.line} — ${preview}`;
	});

	const choice = await ctx.ui.select("Multiple files match the clipboard text", labels);
	if (!choice) return null;

	const selectedIndex = labels.indexOf(choice);
	return selectedIndex >= 0 ? matches[selectedIndex] : null;
}

function buildPrompt(args: {
	instruction: string;
	explainByDefault: boolean;
	relativePath: string;
	line: number;
	needle: string;
	matchCount: number;
}): string {

	const snippet =
		args.needle.length > MAX_SNIPPET_IN_PROMPT
			? `${args.needle.slice(0, MAX_SNIPPET_IN_PROMPT)}\n[clipboard snippet truncated in this prompt; the full clipboard text was used for matching]`
			: args.needle;

	const multipleMatchesNote =
		args.matchCount > 1
			? `Note: ${args.matchCount} files matched the clipboard text, but this one was selected as the target.`
			: "";

	const header = "=== Paste Command Context ===";
	const instructionLine = args.explainByDefault
		? "Instruction: Explain the selected text in the context of this file."
		: `User request: ${args.instruction}`;
	const locationLine = `Location: ${args.relativePath}:${args.line}`;
	const explanationFormat = args.explainByDefault
		? [
			"• Response format: use Markdown so the TUI can render structure clearly.",
			"• Start with a short TL;DR summary.",
			"• Then use real bullet lists for the important details.",
			"• Prefer short sections like **What it does**, **How it works**, and **Key details**.",
			"• Keep paragraphs short; avoid a wall of text.",
		]
		: [];

	// Use bullet points to structure the prompt.
	const bullets = [
		`• ${instructionLine}`,
		`• ${locationLine}`,
		...(multipleMatchesNote ? [`• ${multipleMatchesNote}`] : []),
		...explanationFormat,
		`• Context snippet (anchor):`,
	];

	return [
		header,
		"", // blank line for readability
		...bullets,
		"```",
		snippet,
		"```",
		"", // blank line
		"Use the target file and this snippet as the primary context for the request.",
		"Decide what to do based on the instruction itself: explain, edit, refactor, answer a question, or make no changes.",
		"If the snippet no longer exists in that file, explain that and stop.",
	]
		.filter(Boolean)
		.join("\n\n");
}
