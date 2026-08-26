/**
 * Interactive Loadout HUD — a video game–style equipment screen rendered via
 * ctx.ui.custom(). Pure keyboard-driven: no timers, no background I/O.
 *
 * Key handling is delegated through `matchesKey` from pi-tui so custom
 * keybindings and terminal escape sequences behave consistently.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { isFavorite, scopeLabel, slotOf } from "../config.js";
import { type LoadoutConfig, type ModelRef, SLOT_KEYS, SLOT_LABELS, parseModelRef, shortName } from "../types.js";
import { truncate } from "./formatter.js";

/** Result of a HUD session. */
export type HudResult =
	| { action: "equip"; ref: ModelRef }
	| { action: "assign"; slot: "1" | "2" | "3"; ref: ModelRef }
	| { action: "favorite"; ref: ModelRef; favorited: boolean }
	| { action: "cancel" };

export type HudAction = (result: HudResult) => void;

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

export const showLoadoutHud = async (ctx: ExtensionContext, opts: HudOptions): Promise<HudResult> => {
	if (ctx.mode !== "tui") return { action: "cancel" };

	return ctx.ui.custom<HudResult>((tui, theme, _kb, done) => {
		let selected = 0;
		let toast = opts.initialToast;
		let standby = buildStandby(opts);
		let finished = false;

		const finish = (result: HudResult): void => {
			if (finished) return;
			finished = true;
			done(result);
		};

		const dim = (s: string): string => theme.fg("dim", s);
		const muted = (s: string): string => theme.fg("muted", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const star = (s: string): string => theme.fg("dim", s);

		const padCell = (s: string, w: number): string => {
			const vw = visibleWidth(s);
			return vw >= w ? s : s + " ".repeat(w - vw);
		};

		const render = (width: number): string[] => {
			const inner = Math.min(79, Math.max(40, width - 4));
			const line = (content = ""): string => {
				const vw = visibleWidth(content);
				const pad = Math.max(0, inner - vw);
				return `${dim("│")}${content}${" ".repeat(pad)}${dim("│")}`;
			};
			const border = (l: string, m: string, r: string): string => dim(`${l}${m.repeat(inner)}${r}`);

			const { config } = opts;
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
					out.push(line(`  ${dim(`[${key}]`)} ${padCell(label, 10)} ${dim("(empty — Ctrl+" + key + " on a standby row to assign)")}`));
				}
			}
			out.push(line());

			out.push(line(` ${theme.bold("STANDBY FAVORITES & CATALOG")} ${muted("(↑/↓ to browse):")}`));
			if (standby.length === 0) {
				out.push(line(`   ${dim("(no standby models — favorite one with Ctrl+F from /model)")}`));
			}
			const MAX_ROWS = 8;
			const start = Math.max(0, Math.min(selected - 3, standby.length - MAX_ROWS));
			const window = standby.slice(start, start + MAX_ROWS);
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
			if (standby.length > MAX_ROWS) {
				out.push(line(`   ${dim(`… ${standby.length - MAX_ROWS} more (↑/↓ to scroll)`)}`));
			}
			out.push(line());

			out.push(border("├", "─", "┤"));
			out.push(line(` ${muted("[1-3] Instant Equip Slot    [Ctrl+1/2/3] Assign Highlighted to Slot")}`));
			out.push(line(` ${muted("[↑/↓] Select Standby        [Enter] Equip Selected")}`));
			out.push(line(` ${muted("[Ctrl+F] Toggle Star (*)    [Esc] Cancel / Close")}`));
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
				if (matchesKey(data, "escape")) {
					finish({ action: "cancel" });
					return;
				}

				// Instant equip slots 1–3
				if (SLOT_KEYS.includes(data as "1" | "2" | "3")) {
					const ref = opts.config.slots[data as "1" | "2" | "3"];
					if (ref) {
						finish({ action: "equip", ref });
					} else {
						toast = undefined;
						tui.requestRender();
					}
					return;
				}

				// Assign highlighted → slot (Ctrl+1/2/3)
				for (const key of SLOT_KEYS) {
					if (matchesKey(data, `ctrl+${key}`)) {
						const row = standby[selected];
						if (row) finish({ action: "assign", slot: key, ref: row.ref });
						return;
					}
				}

				if (matchesKey(data, "ctrl+f")) {
					const row = standby[selected];
					if (row) {
						finish({ action: "favorite", ref: row.ref, favorited: !isFavorite(opts.config, row.ref) });
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
					selected = Math.min(Math.max(0, standby.length - 1), selected + 1);
					toast = undefined;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "enter")) {
					const row = standby[selected];
					if (row) finish({ action: "equip", ref: row.ref });
					return;
				}
			},
		};
	});
};
