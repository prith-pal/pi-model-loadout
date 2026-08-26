/**
 * Text layout helpers for the Loadout HUD: ANSI-aware padding, column
 * alignment, and the gray (*) favorite tag.
 */

/** Strip ANSI escape sequences to measure visible width. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const visibleWidth = (text: string): number => text.replace(ANSI_RE, "").length;

/** Pad a string to an exact visible width (no-op when already wider). */
export const padTo = (text: string, width: number): string => {
	const w = visibleWidth(text);
	if (w >= width) return text;
	return text + " ".repeat(width - w);
};

/** Render the subtle gray favorite tag, or blank space to keep columns aligned. */
export const favTag = (isFav: boolean, style: (s: string) => string = (s) => `\x1b[90m${s}\x1b[0m`): string =>
	isFav ? style("(*)") : "   ";

/** Truncate a (plain) string to max chars with an ellipsis. */
export const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

export type RowColumns = {
	/** e.g. "[1]" or "❯" marker column */
	marker: string;
	/** model name column (fixed width) */
	name: string;
	/** provider tag like "[openrouter]" */
	provider: string;
	/** favorite tag */
	fav: string;
	/** right-side metadata (cost, speed) */
	meta: string;
};

/** Join HUD columns with consistent spacing. */
export const formatRow = (cols: RowColumns, nameWidth = 34, providerWidth = 13): string =>
	[
		` ${cols.marker}`,
		padTo(cols.name, nameWidth),
		padTo(cols.provider, providerWidth),
		cols.fav,
		cols.meta ? `│ ${cols.meta}` : "",
	]
		.join(" ")
		.replace(/\s+$/, "");
