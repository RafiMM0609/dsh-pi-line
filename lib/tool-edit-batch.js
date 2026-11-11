/**
 * dsh-tool-edit-batch — batched `edit` tool for DeepSeek Harness.
 *
 * Registers a model-facing `edit` tool that accepts MULTIPLE targeted
 * replacements in ONE call. Every `edits[].oldText` is matched against the
 * ORIGINAL file content (not incrementally), so models can send a whole set
 * of disjoint changes without sequencing hazards.
 *
 * Design notes (mirrors @deepseek-ai/dsh-tool-fs conventions):
 *  - Mutations go through `ctx.fs` (resolve -> stat -> readText -> writeText),
 *    preserving the same-world backend semantics (sandbox, atomic write, CAS).
 *  - The fs-observation-policy gate is honored by dispatching the same
 *    `fs/edit-intent` waterfall; an unobserved file rejects with
 *    FS_NOT_OBSERVED exactly like the stock edit tool.
 *  - CAS: the write is stamped `replaceIfVersion` with the version read in
 *    THIS call, so a concurrent change between read and write fails loudly.
 *  - The observation event `fs/observed` is emitted after success, so later
 *    stock edit/write calls in the same session see fresh state.
 * @module dsh-tool-edit-batch
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FsError } from "@deepseek-ai/dsh-fs";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-edit-batch";

/** Services required by the batched edit tool. */
const inject = ["tools", "fs", "systemPrompt", "workingDirectory"];

const Config = z.object({
	/** Hard cap on edits[] length per call; guards runaway generations. */
	maxEdits: z.number().default(100)
});

/**
 * Resolve the current directory and cancellation for a filesystem call.
 * (Same semantics as tool-fs' helper.)
 * @param ctx - context containing the working-directory service.
 * @param exec - tool execution supplying the agent and cancellation.
 * @returns filesystem resolution options for this call.
 */
async function sessionResolveOptions(ctx, exec) {
	const cwd = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
	return {
		...cwd !== void 0 ? { cwd } : {},
		signal: exec.signal
	};
}

/**
 * Normalize raw tool arguments into a batch: either the pi-style `edits[]`
 * form or the single-edit convenience form (`old_string`/`new_string`).
 * @param args - schema-validated raw arguments.
 * @param maxEdits - configured per-call cap.
 * @returns the batch entries.
 */
function normalizeBatch(args, maxEdits) {
	const edits = [];
	if (Array.isArray(args.edits) && args.edits.length > 0) {
		for (const edit of args.edits) {
			if (typeof edit.oldText !== "string" || edit.oldText.length === 0) throw new Error("each edits[].oldText must be a non-empty string");
			if (edit.oldText === edit.newText) throw new Error("edits[].oldText and edits[].newText must differ");
			edits.push({ oldText: edit.oldText, newText: edit.newText, replaceAll: edit.replace_all ?? false });
		}
	} else if (typeof args.old_string === "string") {
		if (args.old_string.length === 0) throw new Error("old_string must be a non-empty string");
		if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
		edits.push({ oldText: args.old_string, newText: args.new_string ?? "", replaceAll: args.replace_all ?? false });
	} else {
		throw new Error("provide either edits[] or the single-edit form (old_string/new_string)");
	}
	if (edits.length > maxEdits) throw new Error(`too many edits in one call (${edits.length} > maxEdits ${maxEdits}); split the call`);
	return edits;
}

/**
 * Locate every occurrence of `needle` in `haystack`.
 * @param haystack - original file content.
 * @param needle - literal text to match.
 * @returns zero-based start indices of all occurrences.
 */
function findOccurrences(haystack, needle) {
	const indices = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		indices.push(at);
		at = haystack.indexOf(needle, at + 1);
	}
	return indices;
}

/**
 * Apply a batch against the original content. Each entry matches the ORIGINAL
 * text (pi semantics), requires a unique match unless `replaceAll`, and the
 * resulting ranges must not overlap.
 * @param original - the file content read in this call.
 * @param edits - normalized batch.
 * @param displayPath - path used in error text.
 * @returns the rewritten content.
 */
function applyBatch(original, edits, displayPath) {
	const ranges = [];
	for (let i = 0; i < edits.length; i++) {
		const { oldText, newText, replaceAll } = edits[i];
		const hits = findOccurrences(original, oldText);
		if (hits.length === 0) {
			throw new Error(`edits[${i}].oldText not found in "${displayPath}" (matched against the current file content; copy the exact text including whitespace and line endings, or read the file again)`);
		}
		if (!replaceAll && hits.length > 1) {
			throw new Error(`edits[${i}].oldText matches ${hits.length} places in "${displayPath}"; each batched edit must match exactly once unless replace_all is set (extend oldText with more context, or split into separate calls)`);
		}
		for (const start of hits) ranges.push({ start, end: start + oldText.length, newText, index: i });
	}
	ranges.sort((a, b) => a.start - b.start || a.index - b.index);
	for (let i = 1; i < ranges.length; i++) {
		if (ranges[i].start < ranges[i - 1].end) {
			throw new Error(`edits[${ranges[i].index}] overlaps edits[${ranges[i - 1].index}] in "${displayPath}"; edits are matched against the original file, so merge nearby changes into one edit and do not include overlapping or nested matches`);
		}
	}
	let out = "";
	let at = 0;
	for (const range of ranges) {
		out += original.slice(at, range.start);
		out += range.newText;
		at = range.end;
	}
	out += original.slice(at);
	return out;
}

/**
 * Register the batched `edit` tool and its system-prompt guidance.
 * @param ctx - plugin context; registrations are effects scoped to it.
 * @param config - resolved plugin config.
 */
function apply(ctx, config) {
	const maxEdits = config.maxEdits;
	// The guidance section slot `tool:edit` is owned by the stock tool-fs when
	// its edit tool is enabled. Mixed mounting is unsupported (the tool name
	// would collide next), so a duplicate-section failure here means the
	// composition already contributes guidance — skip rather than kill boot.
	try {
		ctx.systemPrompt.section({
			name: "tool:edit",
			order: ctx.systemPrompt.getSectionOrder("TOOL_EDIT"),
			text: ({ scope }) => ctx.tools.get("edit", scope) === void 0 ? "" : "Batch changes to one file into a single edit call. Each edits[].oldText must exactly and uniquely match the ORIGINAL file (all edits match the same pre-edit content). Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions. Read a file before editing it unless you just created or edited it in this session."
		});
	} catch {
		// duplicate `tool:edit` section — stock edit tool is mounted; keep ours silent.
	}
	ctx.tools.register(defineTool({
		name: "edit",
		description: "Edit a UTF-8 text file with one or more targeted literal replacements in one call. Each edit is matched against the ORIGINAL file, not incrementally.",
		parameters: {
			path: {
				type: "string", required: true,
				description: "Path to the file to edit (relative or absolute)."
			},
			edits: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						oldText: {
							type: "string", required: true,
							description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
						},
						newText: {
							type: "string", required: true,
							description: "Replacement text for this targeted edit (empty string deletes the match)."
						},
						replace_all: {
							type: "boolean",
							description: "Replace every occurrence of this oldText instead of requiring a unique match."
						}
					}
				},
				description: "One or more targeted replacements, all matched against the original file. Do not include overlapping or nested edits; if two changes touch the same block or nearby lines, merge them into one edit."
			},
			old_string: {
				type: "string",
				description: "Single-edit convenience form: literal text to replace (use edits[] instead when changing several places)."
			},
			new_string: {
				type: "string",
				description: "Replacement text for the single-edit convenience form."
			},
			replace_all: {
				type: "boolean",
				description: "Replace all matches of old_string. Defaults to false; when false, old_string must appear exactly once."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string", required: true,
						description: "Canonical absolute path in the filesystem execution world."
					},
					before: {
						type: "string", required: true
					},
					after: {
						type: "string", required: true
					},
					applied: {
						type: "number", required: true
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `The file ${value.path} has been updated. ${value.applied} edit(s) applied in one call.`
			}],
			presentationMeta: (_args, value) => ({
				path: value.path,
				diffs: Array.isArray(value.diffs) ? value.diffs : []
			})
		},
		async execute(args, exec) {
			const edits = normalizeBatch(args, maxEdits);
			const target = await ctx.fs.resolve(args.path, await sessionResolveOptions(ctx, exec));
			// Gate: the fs-observation-policy supplies intent (and rejects an
			// unobserved file with FS_NOT_OBSERVED, exactly like the stock edit).
			await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);
			const info = await ctx.fs.stat(target, exec.signal);
			if (info === void 0) {
				ctx.emit("fs/observed", target, { kind: "absent" }, exec);
				throw new FsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
			}
			if (info.type !== "file") throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const original = await ctx.fs.readText(target, exec.signal);
			const content = applyBatch(original, edits, target.displayPath);
			let outcome;
			try {
				outcome = await ctx.fs.writeText(target, content, {
					kind: "replaceIfVersion",
					version: info.version
				}, exec.signal);
			} catch (error) {
				if (error instanceof FsError && error.code === "FS_STALE_VERSION") {
					throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read in this call; read the file again`, "FS_STALE_VERSION");
				}
				throw error;
			}
			ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
			return {
				path: ctx.fs.processPath(target),
				before: original,
				after: content,
				applied: edits.length,
				diffs: edits.map((edit) => ({
					path: target.displayPath,
					oldText: edit.oldText,
					newText: edit.newText
				}))
			};
		},
		presentCall(args) {
			const diffs = Array.isArray(args.edits) && args.edits.length > 0
				? args.edits.map((edit) => ({ path: args.path, oldText: edit.oldText, newText: edit.newText }))
				: [{ path: args.path, oldText: args.old_string || null, newText: args.new_string }];
			return {
				card: "diff",
				title: `Edit ${args.path}`,
				diffs,
				locations: [{ path: args.path }]
			};
		},
		presentResult(args, result) {
			if (result.isError) return void 0;
			const diffs = Array.isArray(result.meta?.diffs) ? result.meta.diffs : void 0;
			if (diffs === void 0) return void 0;
			return {
				card: "diff",
				title: `Edit ${args.path}`,
				diffs
			};
		}
	}));
}

export { Config, apply, inject, name };
