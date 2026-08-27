/**
 * Multi-tier config engine for pi-model-loadout-switcher.
 *
 * Resolution order:
 *   1. Workspace scope: <cwd>/<CONFIG_DIR_NAME>/pi-model-loadout-switcher.json
 *   2. Global scope:    <agentDir>/pi-model-loadout-switcher.json
 *   3. Fresh defaults (written to the global file on first mutation)
 *
 * Reads are validated defensively (unknown/garbage fields are dropped).
 * Writes are atomic: serialize → tmp file → rename.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type CatalogEntry,
	type ConfigScope,
	type LoadoutConfig,
	type ModelRef,
	type ResolvedConfig,
	SLOT_KEYS,
	type SlotKey,
	defaultConfig,
} from "./types.js";

export const CONFIG_FILE_NAME = "pi-model-loadout-switcher.json";

export const workspaceConfigPath = (cwd: string): string => join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

export const globalConfigPath = (): string => join(getAgentDir(), CONFIG_FILE_NAME);

/** Defensive normalization: coerce anything on disk into a valid LoadoutConfig. */
export const normalizeConfig = (raw: unknown): LoadoutConfig => {
	const cfg = defaultConfig();
	if (typeof raw !== "object" || raw === null) return cfg;
	const obj = raw as Record<string, unknown>;

	if (typeof obj.activeModelId === "string" && obj.activeModelId.length > 0) {
		cfg.activeModelId = obj.activeModelId;
	}

	if (typeof obj.slots === "object" && obj.slots !== null) {
		const slots = obj.slots as Record<string, unknown>;
		for (const key of SLOT_KEYS) {
			const value = slots[key];
			if (typeof value === "string" && value.length > 0) {
				cfg.slots[key] = value;
			}
		}
	}

	if (Array.isArray(obj.favorites)) {
		// Dedupe on load — duplicates get merged into a Set and back.
		cfg.favorites = [...new Set(obj.favorites.filter((f): f is ModelRef => typeof f === "string" && f.length > 0))];
	}

	if (Array.isArray(obj.customCatalog)) {
		cfg.customCatalog = obj.customCatalog
			.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
			.filter((e) => typeof e.id === "string" && e.id.length > 0)
			.map(
				(e): CatalogEntry => ({
					id: e.id as string,
					label: typeof e.label === "string" ? e.label : undefined,
					meta: typeof e.meta === "string" ? e.meta : undefined,
				}),
			);
	}

	if (typeof obj.unslothBaseUrl === "string" && obj.unslothBaseUrl.length > 0) {
		cfg.unslothBaseUrl = obj.unslothBaseUrl;
	}

	return cfg;
};

const readConfigFile = (path: string): LoadoutConfig | null => {
	if (!existsSync(path)) return null;
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return null; // corrupt file → treat as absent
	}
};

/**
 * Resolve the effective config for a working directory.
 * Workspace wins; falls back to global; otherwise fresh defaults scoped global.
 */
export const resolveConfig = (cwd: string): ResolvedConfig => {
	const wsPath = workspaceConfigPath(cwd);
	const ws = readConfigFile(wsPath);
	if (ws) return { config: ws, scope: "workspace", path: wsPath };

	const gPath = globalConfigPath();
	const g = readConfigFile(gPath);
	if (g) return { config: g, scope: "global", path: gPath };

	return { config: defaultConfig(), scope: "global", path: gPath };
};

/** Atomic write: tmp file in the same directory, then rename over the target. */
export const saveConfig = (resolved: ResolvedConfig): void => {
	const dir = dirname(resolved.path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${CONFIG_FILE_NAME}.tmp-${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(resolved.config, null, 2)}\n`, "utf-8");
	renameSync(tmp, resolved.path);
};

// ---------------------------------------------------------------------------
// Mutations (pure helpers operating on a LoadoutConfig; callers persist)
// ---------------------------------------------------------------------------

/** O(1) favorite check/insert — favorites list is a Set at heart. */
export const ensureFavorite = (config: LoadoutConfig, ref: ModelRef): void => {
	if (!config.favorites.includes(ref)) config.favorites.push(ref);
};

export const equip = (config: LoadoutConfig, ref: ModelRef): void => {
	config.activeModelId = ref;
};

export const assignSlot = (config: LoadoutConfig, slot: SlotKey, ref: ModelRef): void => {
	config.slots[slot] = ref;
	ensureFavorite(config, ref); // assigning to a slot always favorites
};

export const clearSlot = (config: LoadoutConfig, slot: SlotKey): void => {
	delete config.slots[slot];
};

/** Toggle favorite status; returns the new state (true = now favorited). */
export const toggleFavorite = (config: LoadoutConfig, ref: ModelRef): boolean => {
	const idx = config.favorites.indexOf(ref);
	if (idx === -1) {
		config.favorites.push(ref);
		return true;
	}
	config.favorites.splice(idx, 1);
	return false;
};

export const isFavorite = (config: LoadoutConfig, ref: ModelRef): boolean => config.favorites.includes(ref);

/** Slot number a model is assigned to, if any. */
export const slotOf = (config: LoadoutConfig, ref: ModelRef): SlotKey | undefined => {
	for (const key of SLOT_KEYS) {
		if (config.slots[key] === ref) return key;
	}
	return undefined;
};

export const scopeLabel = (scope: ConfigScope): string =>
	scope === "workspace" ? `Workspace (${CONFIG_DIR_NAME}/)` : "Global (~/.pi/agent/)";
