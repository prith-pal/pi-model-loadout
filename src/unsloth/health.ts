/**
 * Health check for local OpenAI-compatible inference servers (Unsloth, llama.cpp, etc.).
 *
 * Only relevant when the user equips a model whose provider is served locally
 * (e.g. an `unsloth/...` ref pointing at http://127.0.0.1:8000/v1). If you
 * never use local models this module stays inert.
 */

export const DEFAULT_UNSLOTH_BASE_URL = "http://127.0.0.1:8000";

export type HealthResult = {
	ok: boolean;
	/** Model ids reported by /v1/models, when reachable. */
	models: string[];
	latencyMs?: number;
	error?: string;
};

/**
 * Ping `${baseUrl}/v1/models` with a short timeout.
 * Never throws — failures come back as `{ ok: false, error }`.
 */
export const checkLocalServer = async (
	baseUrl: string = DEFAULT_UNSLOTH_BASE_URL,
	timeoutMs = 1500,
): Promise<HealthResult> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = Date.now();
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!res.ok) {
			return { ok: false, models: [], error: `HTTP ${res.status}` };
		}
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const models = Array.isArray(body.data)
			? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
			: [];
		return { ok: true, models, latencyMs: Date.now() - started };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, models: [], error: message };
	} finally {
		clearTimeout(timer);
	}
};

/** True when a model ref looks like it targets the local Unsloth server. */
export const isUnslothRef = (ref: string): boolean => ref.startsWith("unsloth/");

export const UNSLOTH_HINT =
	"Local Unsloth server not detected on :8000. Run 'unsloth serve' or 'unsloth start pi'.";
