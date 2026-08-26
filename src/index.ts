/**
 * pi-model-loadout-switcher
 *
 * Video game–style weapon loadout for pi models: Quick Slots 1/2/3, persistent
 * favorites, and instant switching between local engines (Unsloth/GGUF) and
 * cloud providers (OpenRouter, Anthropic, Google).
 *
 * Storage (first match wins):
 *   - Workspace: <cwd>/<CONFIG_DIR_NAME>/pi-model-loadout-switcher.json
 *   - Global:    ~/.pi/agent/pi-model-loadout-switcher.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	assignSlot,
	equip,
	isFavorite,
	resolveConfig,
	saveConfig,
	toggleFavorite,
} from "./config.js";
import { type ModelRef, type ResolvedConfig, parseModelRef } from "./types.js";
import { type HudResult, showLoadoutHud } from "./ui/modal.js";
import { UNSLOTH_HINT, checkLocalServer, isUnslothRef } from "./unsloth/health.js";

export default function loadoutExtension(pi: ExtensionAPI) {
	let resolved: ResolvedConfig | undefined;

	const persist = (): void => {
		if (resolved) saveConfig(resolved);
	};

	/** Find a model in the registry by "provider/modelId" ref. */
	const findModel = (ctx: ExtensionContext, ref: ModelRef) => {
		const { provider, modelId } = parseModelRef(ref);
		if (!provider) return undefined;
		return ctx.modelRegistry.find(provider, modelId);
	};

	/** Warn when equipping a local Unsloth model while the server is down. */
	const guardUnsloth = async (ctx: ExtensionContext, ref: ModelRef): Promise<void> => {
		if (!isUnslothRef(ref)) return;
		const baseUrl = resolved?.config.unslothBaseUrl;
		const health = await checkLocalServer(baseUrl);
		if (!health.ok) {
			ctx.ui.notify(`⚠️ ${UNSLOTH_HINT}`, "warning");
		}
	};

	/** Equip a model ref: set it in pi, persist, notify. */
	const equipRef = async (ctx: ExtensionContext, ref: ModelRef): Promise<boolean> => {
		if (!resolved) return false;
		const model = findModel(ctx, ref);
		if (!model) {
			ctx.ui.notify(`Model not found in registry: ${ref} (check provider/auth)`, "error");
			return false;
		}
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`No API key available for ${ref}`, "error");
			return false;
		}
		equip(resolved.config, ref);
		persist();
		await guardUnsloth(ctx, ref);
		ctx.ui.notify(`⚔️ Equipped: ${ref}`, "info");
		return true;
	};

	/** Catalog rows for the HUD: registry models not already surfaced. */
	const catalogRows = (ctx: ExtensionContext) => {
		if (!resolved) return [];
		const cfg = resolved.config;
		const metaOf = (ref: string) => cfg.customCatalog.find((e) => e.id === ref)?.meta ?? "";
		const labelOf = (ref: string, fallback: string) =>
			cfg.customCatalog.find((e) => e.id === ref)?.label ?? fallback;

		const rows: { ref: string; label: string; provider: string; meta: string }[] = [];
		const seen = new Set<string>();

		// Scoped models first (mirrors the built-in picker), else full catalogue.
		const scoped = ctx.scopedModels.map((s) => s.model);
		const available = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
		for (const model of available) {
			const ref = `${model.provider}/${model.id}`;
			if (seen.has(ref)) continue;
			seen.add(ref);
			rows.push({ ref, label: labelOf(ref, model.name ?? model.id), provider: model.provider, meta: metaOf(ref) });
		}

		// Custom catalog entries that aren't in the registry still show up.
		for (const entry of cfg.customCatalog) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			rows.push({
				ref: entry.id,
				label: entry.label ?? entry.id,
				provider: parseModelRef(entry.id).provider,
				meta: entry.meta ?? "",
			});
		}
		return rows;
	};

	/** Open the HUD loop; actions that mutate state re-open with a toast. */
	const openHud = async (ctx: ExtensionContext, toast?: string): Promise<void> => {
		if (!resolved) resolved = resolveConfig(ctx.cwd);
		const result: HudResult = await showLoadoutHud(ctx, {
			config: resolved.config,
			scope: resolved.scope,
			activeModelId: resolved.config.activeModelId,
			catalog: catalogRows(ctx),
			initialToast: toast,
		});

		switch (result.action) {
			case "cancel":
				return;
			case "equip":
				await equipRef(ctx, result.ref);
				return;
			case "assign": {
				assignSlot(resolved.config, result.slot, result.ref);
				persist();
				await openHud(ctx, `Assigned ${result.ref} → Slot ${result.slot}`);
				return;
			}
			case "favorite": {
				const nowFav = toggleFavorite(resolved.config, result.ref);
				persist();
				await openHud(ctx, nowFav ? `Starred ${result.ref} (*)` : `Unstarred ${result.ref}`);
				return;
			}
		}
	};

	// --- Commands -------------------------------------------------------------

	pi.registerCommand("loadout", {
		description: "Open the Model Loadout HUD (quick slots 1/2/3 + favorites)",
		handler: async (args, ctx) => {
			if (!resolved) resolved = resolveConfig(ctx.cwd);

			// Fast path: `/loadout 1` equips a slot without opening the HUD.
			const slotArg = args?.trim();
			if (slotArg === "1" || slotArg === "2" || slotArg === "3") {
				const ref = resolved.config.slots[slotArg];
				if (ref) {
					await equipRef(ctx, ref);
				} else {
					ctx.ui.notify(`Slot ${slotArg} is empty — open /loadout and press Ctrl+${slotArg} to assign`, "warning");
				}
				return;
			}
			await openHud(ctx);
		},
	});

	pi.registerCommand("ml", {
		description: "Alias for /loadout",
		handler: async (args, ctx) => {
			if (!resolved) resolved = resolveConfig(ctx.cwd);
			await openHud(ctx);
		},
	});

	// --- Shortcuts ------------------------------------------------------------

	pi.registerShortcut(Key.ctrl("m"), {
		description: "Open the Model Loadout HUD",
		handler: async (ctx) => {
			if (!resolved) resolved = resolveConfig(ctx.cwd);
			await openHud(ctx);
		},
	});

	// --- Session lifecycle ----------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		resolved = resolveConfig(ctx.cwd);
		const cfg = resolved.config;

		// Zero-setup restore: re-apply the saved active model (fall back to slot 1).
		const restoreRef = cfg.activeModelId ?? cfg.slots["1"];
		if (!restoreRef) return;

		// Already on the right model (e.g. restored by pi itself)? Skip.
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (current === restoreRef) return;

		const model = findModel(ctx, restoreRef);
		if (!model) return; // provider/auth not configured — stay silent on startup

		const ok = await pi.setModel(model);
		if (ok) {
			await guardUnsloth(ctx, restoreRef);
			ctx.ui.notify(`⚔️ Loadout restored: ${restoreRef}`, "info");
		}
	});

	// Keep activeModelId in sync when the user changes models outside the HUD.
	pi.on("model_select", async (event, _ctx) => {
		if (!resolved) return;
		const ref = `${event.model.provider}/${event.model.id}`;
		if (resolved.config.activeModelId !== ref) {
			resolved.config.activeModelId = ref;
			persist();
		}
	});
}
