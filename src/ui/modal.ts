/**
 * Interactive Loadout HUD — a video game–style equipment screen rendered via
 * ctx.ui.custom(). Pure keyboard-driven: no timers, no background I/O.
 *
 * Two input modes:
 *  - NORMAL: 1/2/3 equip, Ctrl+Shift+1/2/3 assign, Ctrl+Shift+F star, ↑↓ navigate, Enter equip, Esc close.
 *  - SEARCH (Ctrl+S): keystrokes type into a filter box; the standby list
 *    fuzzy-filters live. Esc clears the text and exits search; Esc on empty
 *    text closes the HUD. ↑↓ move within the filtered list.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { isFavorite, scopeLabel, slotOf } from "../config.js";
import { type LoadoutConfig, type ModelRef, SLOT_KEYS, SLOT_LABELS, parseModelRef, shortName } from "../types.js";
import { truncate } from "./formatter.js";

/** Result of a HUD session. */
export type HudResult =
	| { action: "equip"; ref: ModelRef }
	| { action: "assign"; slot: "1" | "2" | "3"; ref: ModelRef; query: string }
	| { action: "favorite"; ref: ModelRef; favorited: boolean; query: string }
	| { action: "cancel" };

type ListRow = {
	ref: ModelRef;
	label: string;
	provider: string;
	meta: string;
};

type HudOptions = {
	config: LoadoutConfig;
	scope: "workspace" | "global";
	activeModelId?: string;
	/** Extra catalog rows (registry models not already in slots/favorites). */
	catalog: ListRow[];
	/** Inline toast (e.g. "Assigned to slot 2") shown on re-render. */
	initialToast?: string;
	/** Filter query to preserve when a mutation re-opens the HUD. */
	initialQuery?: string;
};

const NAME_W = 36;
const PROV_W = 13;

const metaFor = (config: LoadoutConfig, ref: ModelRef): string =>
	config.customCatalog.find((e) => e.id === ref)?.meta ?? "";

const labelFor = (config: LoadoutConfig, ref: ModelRef): string =>
	config.customCatalog.find((e) => e.id === ref)?.label ?? shortName(ref);

/** Build the standby list: favorites first, then remaining catalog. */
const buildStandby = (opts: HudOptions): ListRow[] => {
	const { config, catalog } = opts;
	const slotted = new Set(SLOT_KEYS.map((k) => config.slots[k]).filter(Boolean) as string[]);
	const rows: ListRow[] = [];
	const seen = new Set<string>();

	for (const ref of config.favorites) {
		if (slotted.has(ref) || seen.has(ref)) continue;
		seen.add(ref);
		rows.push({ ref, label: labelFor(config, ref), provider: parseModelRef(ref).provider, meta: metaFor(config, ref) });
	}
	for (const row of catalog) {
		if (slotted.has(row.ref) || seen.has(row.ref)) continue;
		seen.add(row.ref);
		rows.push(row);
	}
	return rows;
};

/** Fuzzy match: all query chars appear in order (subsequence), case-insensitive. */
const fuzzyMatch = (query: string, text: string): boolean => {
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

	return ctx.ui.custom<HudResult>((tui, theme, _kb, done) => {
		let selected = 0;
		let toast = opts.initialToast;
		let query = opts.initialQuery ?? "";
		let mode: "base" | "search" = opts.initialQuery ? "search" : "base";
		const allStandby = buildStandby(opts);
		let filtered = allStandby;
		let finished = false;

		const finish = (result: HudResult): void => {
			if (finished) return;
			finished = true;
			done(result);
		};

		const refilter = (): void => {
			filtered = applyFilter(allStandby, query);
			selected = Math.min(selected, Math.max(0, filtered.length - 1));
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

		const render = (width: number): string[] => {
			const inner = Math.min(79, Math.max(40, width - 4));
			const line = (content = ""): string => {
				const vw = visibleWidth(content);
				const pad = Math.max(0, inner - vw);
				return `${dim("│")}${content}${" ".repeat(pad)}${dim("│")}`;
			};
			const border = (l: string, m: string, r: string): string => dim(`${l}${m.repeat(inner)}${r}`);

			const active = opts.activeModelId ?? config.activeModelId;
			const out: string[] = [];

			out.push(border("┌", "─", "┐"));
			out.push(line(` ${accent(theme.bold("⚔️  MODEL LOADOUT & FAST SWITCHER"))}`));
			out.push(border("├", "─", "┤"));
			out.push(
				line(
					` ${muted("Scope:")} [ ${scopeLabel(opts.scope)} ]   ${muted("Active:")} ${
						active ? `${accent(shortName(active))} ${muted(`[${parseModelRef(active).provider}]`)}` : muted("(none)")
					}`,
				),
			);
			out.push(line());

			// Search row (Ctrl+S)
			const cursor = mode === "search" ? accent("▏") : "";
			const searchHint = mode === "search" ? "" : dim("(Ctrl+S to filter)");
			out.push(line(` 🔍 ${query}${cursor} ${searchHint}`));
			out.push(line());

			out.push(line(` ${theme.bold("EQUIPPED SLOTS")} ${muted("(press 1, 2, or 3 to instant equip):")}`));
			for (const key of SLOT_KEYS) {
				const ref = config.slots[key];
				const label = `${SLOT_LABELS[key]}:`;
				if (ref) {
					const fav = isFavorite(config, ref) ? star("(*)") : "   ";
					const meta = metaFor(config, ref);
					const isActive = ref === active;
					out.push(
						line(
							`  ${accent(`[${key}]`)} ${padCell(label, 10)} ${padCell(truncate(shortName(ref), NAME_W - 11), NAME_W - 11)}${muted(
								padCell(`[${parseModelRef(ref).provider}]`, PROV_W),
							)} ${fav}${meta ? ` ${dim("│")} ${muted(meta)}` : ""}${isActive ? ` ${star("◂ active")}` : ""}`,
						),
					);
				} else {
					out.push(line(`  ${dim(`[${key}]`)} ${padCell(label, 10)} ${dim("(empty — Ctrl+Shift+" + key + " on a standby row to assign)")}`));
				}
			}
			out.push(line());

			out.push(
				line(
					` ${theme.bold("STANDBY FAVORITES & CATALOG")} ${muted("(↑/↓ to browse):")}${
						query ? ` ${muted(`filtered by "${query}" (${filtered.length}/${allStandby.length})`)}` : ""
					}`,
				),
			);
			if (filtered.length === 0) {
				out.push(line(`   ${dim(allStandby.length === 0 ? "(no standby models)" : `(no matches for "${query}")`)}`));
			}
			const MAX_ROWS = 8;
			const start = Math.max(0, Math.min(selected - 3, filtered.length - MAX_ROWS));
			const window = filtered.slice(start, start + MAX_ROWS);
			window.forEach((row, i) => {
				const idx = start + i;
				const isSel = idx === selected;
				const num = `[${idx + SLOT_KEYS.length + 1}]`;
				const fav = isFavorite(config, row.ref) ? star("(*)") : "   ";
				const slot = slotOf(config, row.ref);
				const slotBadge = slot ? accent(`⚡${slot}`) : "";
				const body = `${padCell(truncate(row.label, NAME_W - 6), NAME_W - 6)}${muted(
					padCell(`[${row.provider}]`, PROV_W),
				)} ${fav}${row.meta ? ` ${dim("│")} ${muted(row.meta)}` : ""}${slotBadge ? ` ${slotBadge}` : ""}`;
				out.push(line(`   ${isSel ? accent(`❯ ${num} `) : dim(`  ${num} `)}${isSel ? accent(body) : body}`));
			});
			if (filtered.length > MAX_ROWS) {
				out.push(line(`   ${dim(`… ${filtered.length - MAX_ROWS} more (↑/↓ to scroll)`)}`));
			}
			out.push(line());

			out.push(border("├", "─", "┤"));
			const hints = mode === "search"
				? [
						" [Type] Filter standby list     [Esc] Clear filter / close when empty",
						" [↑/↓] Move in filtered list   [Enter] Equip highlighted",
						" [Ctrl+Shift+1/2/3] Assign           [Ctrl+Shift+F] Toggle Star (*)",
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
							refilter();
							tui.requestRender();
						} else {
							finish({ action: "cancel" });
						}
						return;
					}
					if (matchesKey(data, "backspace")) {
						query = query.slice(0, -1);
						refilter();
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
							if (row) finish({ action: "assign", slot: key, ref: row.ref, query });
							return;
						}
					}
					// Ctrl+Shift+f (or plain "F" fallback for legacy terminals)
				if (matchesKey(data, "ctrl+shift+f") || data === "F") {
						const row = filtered[selected];
						if (row) {
							finish({ action: "favorite", ref: row.ref, favorited: !isFavorite(config, row.ref), query });
						}
						return;
					}
				// Printable character → append to filter (digits included —
				// in search mode, '3' narrows the query, it does not assign).
				if (data.length === 1 && !matchesKey(data, "ctrl+s")) {
					query += data;
					refilter();
					tui.requestRender();
				}
					return;
				}

				// --- NORMAL MODE -------------------------------------------------
				if (matchesKey(data, "escape")) {
					finish({ action: "cancel" });
					return;
				}

				if (matchesKey(data, "ctrl+s")) {
					mode = "search";
					tui.requestRender();
					return;
				}

				// Ctrl+Shift+1/2/3 must be checked before the bare-digit equip so
				// two chords never collide on terminals that blur modifiers.
				for (const key of SLOT_KEYS) {
					if (matchesKey(data, `ctrl+shift+${key}`)) {
						const row = filtered[selected];
						if (row) finish({ action: "assign", slot: key, ref: row.ref, query });
						return;
					}
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

				// Ctrl+Shift+f (or plain "F" fallback for legacy terminals)
				if (matchesKey(data, "ctrl+shift+f") || data === "F") {
					const row = filtered[selected];
					if (row) {
						finish({ action: "favorite", ref: row.ref, favorited: !isFavorite(config, row.ref), query });
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
