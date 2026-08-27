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
import {
	assignSlot,
	equip,
	isFavorite,
	resolveConfig,
	saveConfig,
	slotOf,
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

	/**
	 * Open the HUD. Equip closes it; assign/favorite mutate in-place via the
	 * built-in `mutate` callback so the filter query is never cleared and the
	 * component stays mounted.
	 */
	const openHud = async (ctx: ExtensionContext, toast?: string, query?: string): Promise<void> => {
		if (!resolved) resolved = resolveConfig(ctx.cwd);
		const result: HudResult = await showLoadoutHud(ctx, {
			config: resolved.config,
			scope: resolved.scope,
			activeModelId: resolved.config.activeModelId,
			catalog: catalogRows(ctx),
			initialToast: toast,
			initialQuery: query,
			mutate: (action) => {
				if (!resolved) return "";
				if (action.kind === "assign") {
					assignSlot(resolved.config, action.slot, action.ref);
					persist();
					return `Assigned ${action.ref} → Slot ${action.slot}`;
				}
				const nowFav = toggleFavorite(resolved.config, action.ref);
				persist();
				return nowFav ? `Starred ${action.ref} (*)` : `Unstarred ${action.ref}`;
			},
		});

		if (result.action === "equip") {
			await equipRef(ctx, result.ref);
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
				if (ref) await equipRef(ctx, ref);
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

	// `/model <query>` extends the native picker: bare `/model` still opens pi's
	// built-in selector (invoked via prompt), but with an argument we resolve
	// against favorites/slots/catalog and equip directly — with completions.
	pi.registerCommand("model", {
		description: "Switch model (loadout favorites) — bare /model opens pi's picker",
		getArgumentCompletions: (prefix) => {
			if (!resolved) return null;
			const cfg = resolved.config;
			const refs = new Set<string>([
				...Object.values(cfg.slots).filter((v): v is string => !!v),
				...cfg.favorites,
				...cfg.customCatalog.map((e) => e.id),
			]);
			const slotBadge = (ref: string): string => {
				const slot = slotOf(cfg, ref);
				if (slot) return `⚡ slot ${slot}`;
				return isFavorite(cfg, ref) ? "(*) favorite" : "catalog";
			};
			const items = [...refs].map((ref) => ({ value: ref, label: ref, description: slotBadge(ref) }));
			const filtered = items.filter((i) => i.value.includes(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!resolved) resolved = resolveConfig(ctx.cwd);
			const query = args?.trim();
			if (!query) {
				await openHud(ctx); // bare /model → our HUD instead of nothing
				return;
			}
			await equipRef(ctx, query);
		},
	});

	// --- Shortcut: ctrl+shift+l (L = Loadout) ----------------------------------
	pi.registerShortcut("ctrl+shift+l", {
		description: "Open the Model Loadout HUD",
		handler: async (ctx) => {
			if (!resolved) resolved = resolveConfig(ctx.cwd);
			await openHud(ctx);
		},
	});

	// --- Session lifecycle ----------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		resolved = resolveConfig(ctx.cwd);

		// Zero-setup restore: re-apply the saved active model (fall back to slot 1).
		const restoreRef = resolved.config.activeModelId ?? resolved.config.slots["1"];
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
