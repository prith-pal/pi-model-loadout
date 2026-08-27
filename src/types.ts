/**
 * Type definitions for pi-model-loadout.
 */

/** Canonical model reference: "provider/modelId" (e.g. "anthropic/claude-sonnet-4-5"). */
export type ModelRef = string;

/** Quick slot keys, video-game style. */
export type SlotKey = "1" | "2" | "3";

export const SLOT_KEYS: readonly SlotKey[] = ["1", "2", "3"];

/**
 * User-supplied catalog entry for models that may not (yet) be resolvable in
 * pi's registry, or to attach display metadata (cost, speed, notes).
 */
export type CatalogEntry = {
	/** "provider/modelId" */
	id: ModelRef;
	/** Human label shown in the HUD instead of the raw id. */
	label?: string;
	/** Optional free-form annotation for the HUD's right column (e.g. your own notes).
	 *  Pi's registry exposes no cost/speed data, so this is only what you write yourself. */
	meta?: string;
};

/** Persisted configuration shape (workspace or global scope). */
export type LoadoutConfig = {
	$schema?: string;
	/** Currently equipped model, "provider/modelId". */
	activeModelId?: ModelRef;
	/** Quick slots 1–3. Missing slots render as "(empty)". */
	slots: Partial<Record<SlotKey, ModelRef>>;
	/** Favorited models (shown with a gray (*) tag). */
	favorites: ModelRef[];
	/** Extra catalog entries / metadata overrides. */
	customCatalog: CatalogEntry[];
	/** Base URL of the local OpenAI-compatible server used for health checks. */
	unslothBaseUrl?: string;
};

/** Which scope a config was resolved from (drives HUD "Scope:" line + writes). */
export type ConfigScope = "workspace" | "global";

/** A resolved config: data + where it lives. */
export type ResolvedConfig = {
	config: LoadoutConfig;
	scope: ConfigScope;
	/** Absolute path of the file backing this config. */
	path: string;
};

/** Default config used when no file exists yet. */
export const defaultConfig = (): LoadoutConfig => ({
	activeModelId: undefined,
	slots: {},
	favorites: [],
	customCatalog: [],
});

/** Parse "provider/modelId" into its parts. Provider is the first segment. */
export const parseModelRef = (ref: ModelRef): { provider: string; modelId: string } => {
	const slash = ref.indexOf("/");
	if (slash === -1) {
		return { provider: "", modelId: ref };
	}
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
};

/** Short display name: the modelId part of a ref. */
export const shortName = (ref: ModelRef): string => parseModelRef(ref).modelId;

/**
 * Format per-million-token cost for the HUD: "$0.16 / $0.47" (costs are
 * always $/1M, so the unit is implied). Returns "free" when both input and
 * output are zero.
 */
export const formatCost = (cost?: { input: number; output: number } | null): string => {
	if (!cost) return "";
	if (cost.input === 0 && cost.output === 0) return "free";
	const usd = (n: number): string => (n === 0 ? "0" : String(parseFloat(n.toFixed(3))));
	return `$${usd(cost.input)} / $${usd(cost.output)}`;
};
