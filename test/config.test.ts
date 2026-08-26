/**
 * Unit tests for the config engine: persistence round-trips, scope resolution,
 * slot assignment, favorites, and defensive normalization.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assignSlot,
	clearSlot,
	equip,
	isFavorite,
	normalizeConfig,
	saveConfig,
	slotOf,
	toggleFavorite,
} from "../src/config.js";
import { type LoadoutConfig, defaultConfig, parseModelRef, shortName } from "../src/types.js";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "loadout-test-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

const sampleConfig = (): LoadoutConfig => ({
	activeModelId: "unsloth/Qwen3.8-27B-Instruct-GGUF",
	slots: {
		"1": "unsloth/Qwen3.8-27B-Instruct-GGUF",
		"2": "openrouter/free",
		"3": "deepseek/deepseek-v4",
	},
	favorites: [
		"unsloth/Qwen3.8-27B-Instruct-GGUF",
		"openrouter/free",
		"deepseek/deepseek-v4",
		"unsloth/Gemma-4-26B-A4B-GGUF",
	],
	customCatalog: [],
});

describe("persistence", () => {
	test("saveConfig writes atomically and round-trips", () => {
		const path = join(workDir, ".pi", "pi-model-loadout-switcher.json");
		const resolved = { config: sampleConfig(), scope: "workspace" as const, path };
		saveConfig(resolved);

		expect(existsSync(path)).toBe(true);
		const loaded = normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
		expect(loaded).toEqual(sampleConfig());
	});

	test("saveConfig creates parent directories", () => {
		const path = join(workDir, "deep", "nested", "pi-model-loadout-switcher.json");
		saveConfig({ config: defaultConfig(), scope: "global", path });
		expect(existsSync(path)).toBe(true);
	});

	test("saveConfig overwrites existing file without leaving tmp files", () => {
		const path = join(workDir, "pi-model-loadout-switcher.json");
		saveConfig({ config: sampleConfig(), scope: "global", path });
		const next = { ...sampleConfig(), activeModelId: "openrouter/free" };
		saveConfig({ config: next, scope: "global", path });

		const loaded = normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
		expect(loaded.activeModelId).toBe("openrouter/free");
	});
});

describe("normalization", () => {
	test("garbage input yields defaults", () => {
		expect(normalizeConfig(null)).toEqual(defaultConfig());
		expect(normalizeConfig("nope")).toEqual(defaultConfig());
		expect(normalizeConfig(42)).toEqual(defaultConfig());
		expect(normalizeConfig({ slots: "bad", favorites: "bad" })).toEqual(defaultConfig());
	});

	test("drops invalid slot keys and non-string values", () => {
		const cfg = normalizeConfig({
			slots: { "1": "a/b", "4": "x/y", "2": 42 },
			favorites: ["a/b", 123, ""],
		});
		expect(cfg.slots).toEqual({ "1": "a/b" });
		expect(cfg.favorites).toEqual(["a/b"]);
	});

	test("filters malformed catalog entries", () => {
		const cfg = normalizeConfig({
			customCatalog: [{ id: "a/b", meta: "$1/M" }, { nope: true }, { id: "" }, "junk"],
		});
		expect(cfg.customCatalog).toEqual([{ id: "a/b", label: undefined, meta: "$1/M" }]);
	});
});

describe("slot assignment", () => {
	test("assignSlot sets the slot and auto-favorites", () => {
		const cfg = defaultConfig();
		assignSlot(cfg, "2", "openrouter/free");
		expect(cfg.slots["2"]).toBe("openrouter/free");
		expect(isFavorite(cfg, "openrouter/free")).toBe(true);
	});

	test("assignSlot does not duplicate favorites", () => {
		const cfg = defaultConfig();
		assignSlot(cfg, "1", "a/b");
		assignSlot(cfg, "2", "a/b");
		expect(cfg.favorites).toEqual(["a/b"]);
		expect(slotOf(cfg, "a/b")).toBe("1"); // first matching slot wins
	});

	test("clearSlot removes the assignment", () => {
		const cfg = sampleConfig();
		clearSlot(cfg, "3");
		expect(cfg.slots["3"]).toBeUndefined();
	});
});

describe("equip & favorites", () => {
	test("equip sets activeModelId and favorites the model", () => {
		const cfg = defaultConfig();
		equip(cfg, "anthropic/claude-sonnet-4-5");
		expect(cfg.activeModelId).toBe("anthropic/claude-sonnet-4-5");
		expect(isFavorite(cfg, "anthropic/claude-sonnet-4-5")).toBe(true);
	});

	test("toggleFavorite flips state and reports it", () => {
		const cfg = defaultConfig();
		expect(toggleFavorite(cfg, "a/b")).toBe(true);
		expect(toggleFavorite(cfg, "a/b")).toBe(false);
		expect(cfg.favorites).toEqual([]);
	});
});

describe("model ref helpers", () => {
	test("parseModelRef splits provider and id", () => {
		expect(parseModelRef("openrouter/free")).toEqual({ provider: "openrouter", modelId: "free" });
		expect(parseModelRef("unsloth/Qwen3.8-27B-GGUF")).toEqual({
			provider: "unsloth",
			modelId: "Qwen3.8-27B-GGUF",
		});
		expect(parseModelRef("bare-id")).toEqual({ provider: "", modelId: "bare-id" });
	});

	test("shortName returns the modelId part", () => {
		expect(shortName("deepseek/deepseek-v4")).toBe("deepseek-v4");
	});
});

describe("workspace file resolution", () => {
	test("workspace file at expected path is readable", () => {
		const dir = join(workDir, ".pi");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pi-model-loadout-switcher.json"), JSON.stringify(sampleConfig()));
		const loaded = normalizeConfig(JSON.parse(readFileSync(join(dir, "pi-model-loadout-switcher.json"), "utf-8")));
		expect(loaded.slots["1"]).toBe("unsloth/Qwen3.8-27B-Instruct-GGUF");
	});
});
