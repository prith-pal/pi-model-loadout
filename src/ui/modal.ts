/**
 * Interactive Loadout HUD — a video game–style equipment screen rendered via
 * ctx.ui.custom(). Pure keyboard-driven: no timers, no background I/O.
 *
 * Two input modes:
 *  - BASE:    1/2/3 equip, Ctrl+Shift+1/2/3 assign, Ctrl+Shift+F star,
 *             ↑↓ navigate, Enter equip, Esc close, Ctrl+S enter search.
 *  - SEARCH:  Ctrl+S entered; printable keys (digits included) filter;
 *             Ctrl+Shift+1/2/3 assign, Ctrl+Shift+F star;
 *             ↑↓/Enter operate on the filtered row;
 *             Ctrl+U / Ctrl+Backspace clear query; Esc clears or exits.
 *
 * The filtered list is a pure derivation of allStandby.filter(query).
 * Ctrl+Shift assign/favorite mutate in-place (no close/re-open) so the
 * query and selection survive across mutations.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import { isFavorite, scopeLabel, slotOf } from "../config.js";
import { type LoadoutConfig, type ModelRef, SLOT_KEYS, parseModelRef, shortName } from "../types.js";
/**
 * Truncate keeping the tail ("…MiniMax-M2.5"). Model ids repeat their org
 * prefix within a provider but the tail (version/flavor) disambiguates,
 * and the filter query matches the full id anyway.
 */
const truncateTail = (s: string, max: number): string => (s.length <= max ? s : `…${s.slice(-(Math.max(0, max - 1)))}`);
/** Right-align within a fixed visible width (left-padded). */
const padRight = (s: string, w: number): string => {
	const vw = visibleWidth(s);
	return vw >= w ? s : " ".repeat(w - vw) + s;
};

/** Result of a HUD session — only emitted when the HUD actually closes. */
export type HudResult =
	| { action: "equip"; ref: ModelRef }
	| { action: "assign"; slot: "1" | "2" | "3"; ref: ModelRef; query: string }
	| { action: "favorite"; ref: ModelRef; favorited: boolean; query: string }
	| { action: "cancel" };

/** Inline HUD state-mutation callback (assign/favorite without closing). */
export type HudMutator = (
	action:
		| { kind: "assign"; slot: "1" | "2" | "3"; ref: ModelRef }
		| { kind: "favorite"; ref: ModelRef; favorited: boolean },
) => string /* toast message */;

type ListRow = {
	ref: ModelRef;
	label: string;
	provider: string;
	meta: string;
	/** Pre-formatted cost string, e.g. "$0.16 / $0.47 per 1M" ("" when unknown). */
	cost?: string;
};

type HudOptions = {
	config: LoadoutConfig;
	scope: "workspace" | "global";
	activeModelId?: string;
	/** Extra catalog rows (registry models not already in favorites/slots). */
	catalog: ListRow[];
	/** Inline toast (e.g. "Assigned to slot 2") shown on open. */
	initialToast?: string;
	/** Filter query to preserve when re-opening (no longer used for closure). */
	initialQuery?: string;
	/** Mutator that applies a config change in-place + persists. */
	mutate: HudMutator;
};

/** Build O(1) lookup maps for custom-catalog name/meta overrides once. */
const buildCatalogMaps = (config: LoadoutConfig): { meta: Map<string, string>; label: Map<string, string> } => {
	const meta = new Map<string, string>();
	const label = new Map<string, string>();
	for (const entry of config.customCatalog) {
		if (entry.meta) meta.set(entry.id, entry.meta);
		if (entry.label) label.set(entry.id, entry.label);
	}
	return { meta, label };
};

/** Build the standby list: favorites first, then remaining catalog. */
const buildStandby = (opts: { config: LoadoutConfig; catalog: ListRow[] }): ListRow[] => {
	const { config, catalog } = opts;
	const { label, meta } = buildCatalogMaps(config);
	const slotted = new Set(SLOT_KEYS.map((k) => config.slots[k]).filter(Boolean) as string[]);
	const rows: ListRow[] = [];
	const seen = new Set<string>();

	// Catalog rows carry registry data (cost, meta); favorites reuse them so a
	// starred model still shows its identifier + cost.
	const catalogByRef = new Map(catalog.map((r) => [r.ref, r]));

	for (const ref of config.favorites) {
		if (slotted.has(ref) || seen.has(ref)) continue;
		seen.add(ref);
		const catalogRow = catalogByRef.get(ref);
		if (catalogRow) {
			rows.push(catalogRow);
			continue;
		}
		rows.push({
			ref,
			label: label.get(ref) ?? shortName(ref),
			provider: parseModelRef(ref).provider,
			meta: meta.get(ref) ?? "",
			cost: "",
		});
	}
	for (const row of catalog) {
		if (slotted.has(row.ref) || seen.has(row.ref)) continue;
		seen.add(row.ref);
		rows.push(row);
	}
	return rows;
};

/** Fuzzy match: all query chars appear in order (subsequence), case-insensitive. */
export const fuzzyMatch = (query: string, text: string): boolean => {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let ti = 0;
	for (const ch of q) {
		const found = t.indexOf(ch, ti);
		if (found === -1) return false;
		ti = found + 1;
	}
	return true;
};

const applyFilter = (rows: ListRow[], query: string): ListRow[] => {
	if (!query) return rows;
	return rows.filter((r) => fuzzyMatch(query, `${r.ref} ${r.label} ${r.provider}`));
};

export const showLoadoutHud = async (ctx: ExtensionContext, opts: HudOptions): Promise<HudResult> => {
	if (ctx.mode !== "tui") return { action: "cancel" };

	// Standby list is derived once per render from opts (config + catalog live
	// in the parent scope; mutations create a new opts object via re-render).
	let standby: ListRow[] = buildStandby(opts);

	return ctx.ui.custom<HudResult>((tui, theme, _kb, done) => {
		let selected = 0;
		let toast = opts.initialToast;
		let query = opts.initialQuery ?? "";
		let mode: "base" | "search" = opts.initialQuery ? "search" : "base";
		let filtered = applyFilter(standby, query);
		let finished = false;

		const finish = (result: HudResult): void => {
			if (finished) return;
			finished = true;
			done(result);
		};

		const rebuild = (): void => {
			// Rebuild standby after config mutation while preserving query/selected.
			standby = buildStandby(opts);
			filtered = applyFilter(standby, query);
			selected = Math.min(selected, Math.max(0, filtered.length - 1));
			tui.requestRender();
		};

		const dim = (s: string): string => theme.fg("dim", s);
		const muted = (s: string): string => theme.fg("muted", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const star = (s: string): string => theme.fg("dim", s);

		const padCell = (s: string, w: number): string => {
			const vw = visibleWidth(s);
			return vw >= w ? s : s + " ".repeat(w - vw);
		};

		const { config } = opts;
		const { meta: catalogMeta } = buildCatalogMaps(config);
		// Registry cost for a ref — lets slotted models show the same cost
		// column as standby rows.
		const costByRef = new Map(opts.catalog.map((r) => [r.ref, r.cost ?? ""]));

		const render = (width: number): string[] => {
			const inner = Math.max(30, Math.min(79, width - 4));
			const line = (content = ""): string => {
				const vw = visibleWidth(content);
				const pad = Math.max(0, inner - vw);
				return `${dim("│")}${content}${" ".repeat(pad)}${dim("│")}`;
			};
			const border = (l: string, m: string, r: string): string => dim(`${l}${m.repeat(inner)}${r}`);

			const active = opts.activeModelId ?? config.activeModelId;
			const out: string[] = [];

			out.push(border("┌", "─", "┐"));
			out.push(line(` ${accent(theme.bold("⚔️  MODEL LOADOUT"))}`));
			out.push(border("├", "─", "┤"));
			out.push(
				line(
					` ${muted("Scope:")} [ ${scopeLabel(opts.scope)} ]   ${muted("Active:")} ${
						active ? `${accent(shortName(active))} ${muted(`[${parseModelRef(active).provider}]`)}` : muted("(none)")
					}`,
				),
			);
			out.push(line());

			const cursor = mode === "search" ? accent("▏") : "";
			const searchHint = mode === "search" ? "" : dim("(Ctrl+S to filter)");
			out.push(line(` 🔍 ${query}${cursor} ${searchHint}`));
			out.push(line());

			// Column widths, uniform across slots + standby so every column
			// aligns. provW: widest provider tag among standby rows + slotted
			// models (few providers, stable across scrolls).
			const provSet = new Set([
				...filtered.map((r) => r.provider),
				...Object.values(config.slots).filter((v): v is string => !!v).map((r) => parseModelRef(r).provider),
			]);
			const provW = Math.max(6, ...[...provSet].map((p) => visibleWidth(`[${p}]`)));

			const MAX_ROWS = 8;
			// Compute the visible window clamped to [0, filtered.length - MAX_ROWS].
			const start = Math.max(0, Math.min(selected - 3, filtered.length - MAX_ROWS));
			const window = filtered.slice(start, start + MAX_ROWS);
			// costW + maxSuffix are sized to the VISIBLE window + slotted models,
			// so a rarely-seen $0.2574 / $1.0287-style price doesn't hollow out
			// the column for typical rows (width may shift by a char on scroll).
			const slotCosts = Object.values(config.slots)
				.filter((v): v is string => !!v)
				.map((ref) => costByRef.get(ref) ?? "");
			const costW = Math.max(
				4,
				...window.map((r) => (r.cost ? visibleWidth(r.cost) : 0)),
				...slotCosts.map((c) => visibleWidth(c)),
			);
			const maxSuffix = Math.max(
				0,
				...window.map((r) => {
					const b = slotOf(config, r.ref) ? visibleWidth(" ⚡1") : 0;
					const m = r.meta ? 1 + visibleWidth(r.meta) : 0;
					return b + m;
				}),
			);
			// Prefix is `   ❯ [N] ` (worst case 12 cols); then label, gap, right-
			// aligned provider, fav (3), badge/meta, gap, right-aligned cost.
			const labelW = Math.max(16, inner - 12 - 1 - provW - 3 - maxSuffix - 1 - costW);

			out.push(line(` ${theme.bold("EQUIPPED SLOTS")} ${muted("(press 1, 2, or 3 to instant equip):")}`));
			for (const key of SLOT_KEYS) {
				const ref = config.slots[key];
				if (ref) {
					const fav = isFavorite(config, ref) ? star("(*)") : "   ";
					const meta = catalogMeta.get(ref) ?? "";
					const isActive = ref === active;
					const prov = `[${parseModelRef(ref).provider}]`;
					// Same columns as standby: slot prefix `  [1] ` is 7 cols vs the
					// standby's ~9, so nameW = labelW + 2 lines up the provider and
					// cost columns exactly.
					const nameW = labelW + 3;
					const cost = costByRef.get(ref) ?? "";
					const costStr = cost ? ` ${padRight(muted(cost), costW)}` : "";
					const midStr = padCell(meta ? ` ${dim("│")} ${muted(meta)}` : "", maxSuffix);
					const body = `${padCell(truncateTail(shortName(ref), nameW), nameW)} ${muted(padRight(prov, provW))} ${fav}${midStr}${costStr}`;
					// The active slot is highlighted (accent), matching the
				// header's Active: line, without extra column width.
					out.push(line(`  ${accent(`[${key}]`)} ${isActive ? accent(body) : body}`));
				} else {
					out.push(line(`  ${dim(`[${key}]`)} ${dim("(empty — Ctrl+Shift+" + key + " to assign)")}`));
				}
			}
			out.push(line());

			out.push(
				line(
					` ${theme.bold("STANDBY FAVORITES & CATALOG")} ${muted("(↑/↓ to browse):")}${
						query ? ` ${muted(`filtered by "${query}" (${filtered.length}/${standby.length})`)}` : ""
					}`,
				),
			);
			if (filtered.length === 0) {
				out.push(line(`   ${dim(standby.length === 0 ? "(no standby models)" : `(no matches for "${query}")`)}`));
			}
			window.forEach((row, i) => {
				const idx = start + i;
				const isSel = idx === selected;
				const num = `[${idx + SLOT_KEYS.length + 1}]`;
				const fav = isFavorite(config, row.ref) ? star("(*)") : "   ";
				const slot = slotOf(config, row.ref);
				const slotBadge = slot ? accent(`⚡${slot}`) : "";
				const metaStr = row.meta ? ` ${dim("│")} ${muted(row.meta)}` : "";
				const badgeStr = slotBadge ? ` ${slotBadge}` : "";
				const costStr = row.cost ? ` ${padRight(muted(row.cost), costW)}` : "";
				// Pad the badge/meta region so every row's cost column starts at the same spot.
				const midStr = padCell(`${badgeStr}${metaStr}`, maxSuffix);
				const body = `${padCell(truncateTail(row.label, labelW), labelW)} ${muted(padRight(`[${row.provider}]`, provW))} ${fav}${midStr}${costStr}`;
				out.push(line(`   ${isSel ? accent(`❯ ${num} `) : dim(`  ${num} `)}${isSel ? accent(body) : body}`));
			});
			if (filtered.length > MAX_ROWS) {
				out.push(line(`   ${dim(`… ${filtered.length - MAX_ROWS} more (↑/↓ to scroll)`)}`));
			}
			out.push(line());

			out.push(border("├", "─", "┤"));
			const hints =
				mode === "search"
					? [
							" [Type] Filter standby list     [Esc] Clear filter / close when empty",
							" [↑/↓] Move in filtered list   [Enter] Equip highlighted",
							" [Ctrl+Shift+1/2/3] Assign    [Ctrl+Shift+F] Toggle Star (*)",
						]
					: [
							" [1-3] Instant Equip Slot    [Ctrl+Shift+1/2/3] Assign Highlighted to Slot",
							" [↑/↓] Select Standby        [Enter] Equip Selected",
							" [Ctrl+S] Filter             [Ctrl+Shift+F] Toggle Star (*)    [Esc] Close",
						];
			for (const h of hints) out.push(line(muted(h)));
			if (toast) {
				out.push(line(` ${theme.fg("success", `✔ ${toast}`)}`));
			}
			out.push(border("└", "─", "┘"));
			return out;
		};

		return {
			render,
			invalidate() {},
			handleInput(data: string): void {
				// --- SEARCH MODE ------------------------------------------------
				if (mode === "search") {
					if (matchesKey(data, "escape")) {
						if (query) {
							query = "";
							mode = "base";
							filtered = applyFilter(standby, query);
							tui.requestRender();
						} else {
							finish({ action: "cancel" });
						}
						return;
					}
					if (matchesKey(data, "backspace")) {
						query = query.slice(0, -1);
						filtered = applyFilter(standby, query);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+backspace")) {
						query = "";
						filtered = applyFilter(standby, query);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "up")) {
						selected = Math.max(0, selected - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						selected = Math.min(Math.max(0, filtered.length - 1), selected + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						const row = filtered[selected];
						if (row) finish({ action: "equip", ref: row.ref });
						return;
					}
					for (const key of SLOT_KEYS) {
						if (matchesKey(data, `ctrl+shift+${key}`)) {
							const row = filtered[selected];
							if (row) {
								toast = opts.mutate({ kind: "assign", slot: key, ref: row.ref });
								rebuild();
							}
							return;
						}
					}
					if (matchesKey(data, "ctrl+shift+f")) {
						const row = filtered[selected];
						if (row) {
							toast = opts.mutate({ kind: "favorite", ref: row.ref, favorited: !isFavorite(config, row.ref) });
							rebuild();
						}
						return;
					}
					// Printable character → append to filter (digits included —
					// in search mode, '3' narrows the query, it does not assign).
					if (data.length === 1 && !matchesKey(data, "ctrl+s")) {
						query += data;
						filtered = applyFilter(standby, query);
						tui.requestRender();
					}
					return;
				}

				// --- BASE MODE ------------------------------------------------
				if (matchesKey(data, "escape")) {
					finish({ action: "cancel" });
					return;
				}

				if (matchesKey(data, "ctrl+s")) {
					mode = "search";
					tui.requestRender();
					return;
				}

				// Ctrl+Shift+1/2/3 checked before the bare-digit equip so the
				// two chords never collide on terminals that blur modifiers.
				for (const key of SLOT_KEYS) {
					if (matchesKey(data, `ctrl+shift+${key}`)) {
						const row = filtered[selected];
						if (row) {
							toast = opts.mutate({ kind: "assign", slot: key, ref: row.ref });
							rebuild();
						}
						return;
					}
				}

				if (matchesKey(data, "ctrl+shift+f")) {
					const row = filtered[selected];
					if (row) {
						toast = opts.mutate({ kind: "favorite", ref: row.ref, favorited: !isFavorite(config, row.ref) });
						rebuild();
					}
					return;
				}

				if (SLOT_KEYS.includes(data as "1" | "2" | "3")) {
					const ref = config.slots[data as "1" | "2" | "3"];
					if (ref) {
						finish({ action: "equip", ref });
					} else {
						toast = undefined;
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, "up")) {
					selected = Math.max(0, selected - 1);
					toast = undefined;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down")) {
					selected = Math.min(Math.max(0, filtered.length - 1), selected + 1);
					toast = undefined;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "enter")) {
					const row = filtered[selected];
					if (row) finish({ action: "equip", ref: row.ref });
					return;
				}
			},
		};
	});
};
