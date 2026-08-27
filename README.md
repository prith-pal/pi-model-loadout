# ⚔️ pi-model-loadout-switcher

A video game–style **Weapon Loadout** (Quick Slots 1 / 2 / 3) and persistent favorites system for [`pi-coding-agent`](https://github.com/badlogic/pi-mono). Instantly switch between local engines (Unsloth/GGUF on Apple Silicon) and cloud providers (OpenRouter, Anthropic, Google) without touching `/model`.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚔️  MODEL LOADOUT & FAST SWITCHER                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ Scope: [ Workspace (.pi/) ]   Active: Qwen3.8-27B-Instruct [unsloth]        │
│                                                                             │
│  EQUIPPED SLOTS (press 1, 2, or 3 to instant equip):                        │
│  [1] Primary  : Qwen3.8-27B-Instruct     [unsloth]     (*)  ◂ active       │
│  [2] Secondary: openrouter/free          [openrouter]  (*)                 │
│  [3] Heavy    : deepseek-v4              [deepseek]    (*)                 │
│                                                                             │
│  STANDBY FAVORITES & CATALOG (↑/↓ to browse):                               │
│    ❯ [4] Gemma-4-26B-A4B                 [unsloth]     (*)                 │
│      [5] gemini-2.5-flash                [google]      (*)                 │
│      [6] claude-3-7-sonnet               [anthropic]                       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  [1-3] Instant Equip Slot    [Ctrl+Shift+1/2/3] Assign Highlighted to Slot        │
│  [↑/↓] Select Standby        [Enter] Equip Selected                         │
│  [Ctrl+Shift+F] Toggle Star (*)    [Esc] Cancel / Close                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Installation

**Option A — drop into your global extensions directory (hot-reloadable):**

```bash
git clone <this-repo> ~/.pi/agent/extensions/pi-model-loadout-switcher
# then in pi: /reload
```

**Option B — as a pi package via settings.json:**

```json
{
  "packages": ["git:github.com/<you>/pi-model-loadout-switcher@v1"]
}
```

**Option C — quick test:**

```bash
pi -e ./pi-model-loadout-switcher/src/index.ts
```

## Usage

| Input | Action |
|---|---|
| `/loadout` or `/ml` | Open the Loadout HUD |
| `/loadout 1` | Instant-equip Slot 1 without opening the HUD (also `2`, `3`) |
| `/model <query>` | Equip directly; tab-completes your favorites/slots (bare `/model` opens pi's native picker) |
| `Ctrl+Shift+L` | Open the Loadout HUD from anywhere |

### Inside the HUD

## Session restore

On `session_start`, the extension re-applies your saved `activeModelId` (falling back to Slot 1) — zero manual setup after restart, `/new`, or `/resume`.

## Configuration

First match wins; writes go back to the file that was loaded.

| Scope | Path |
|---|---|
| Workspace | `.pi/pi-model-loadout-switcher.json` (in the active repo) |
| Global | `~/.pi/agent/pi-model-loadout-switcher.json` |

```json
{
  "activeModelId": "unsloth/Qwen3.8-27B-Instruct-GGUF",
  "slots": {
    "1": "unsloth/Qwen3.8-27B-Instruct-GGUF",
    "2": "openrouter/free",
    "3": "deepseek/deepseek-v4"
  },
  "favorites": [
    "unsloth/Qwen3.8-27B-Instruct-GGUF",
    "openrouter/free",
    "deepseek/deepseek-v4",
    "unsloth/Gemma-4-26B-A4B-GGUF"
  ],
  "customCatalog": [
    { "id": "unsloth/Qwen3.8-27B-Instruct-GGUF", "label": "Qwen 27B (local)" }
  ],
  "unslothBaseUrl": "http://127.0.0.1:8000"
}
```

- All model refs are `"provider/modelId"` and must resolve in pi's model registry (`pi --list-models`) with auth configured.
- `customCatalog[].label` overrides the display name; `customCatalog[].meta` is an optional free-form annotation shown in the right-hand HUD column. Pi's registry doesn't expose cost or tokens-per-second, so nothing is shown unless you write it yourself.
- Writes are atomic (tmp file + rename); corrupt files are treated as absent rather than crashing your session.

## Local Unsloth health check

If you equip an `unsloth/...` model and nothing answers on `http://127.0.0.1:8000/v1`, you'll get:

> ⚠️ Local Unsloth server not detected on :8000. Run 'unsloth serve' or 'unsloth start pi'.

The check is a 1.5s-timeout `GET /v1/models` and never blocks startup. If you don't use local models, it stays completely inert. Point it elsewhere with `unslothBaseUrl`.

## Development

```bash
bun install          # dev deps (typescript, @types/*)
bun test             # unit tests (config engine, slots, favorites)
bun run typecheck    # strict tsc --noEmit
```

### Project layout

```text
src/
├── index.ts           # Extension entrypoint: commands, shortcuts, session hooks
├── types.ts           # Config schema + model-ref helpers
├── config.ts          # Workspace/global resolution, atomic saves, mutations
├── ui/
│   ├── modal.ts       # Loadout HUD (ctx.ui.custom component + key handling)
│   └── formatter.ts   # ANSI-aware padding, gray (*) tags, column layout
└── unsloth/
    └── health.ts      # localhost:8000/v1 health probe
test/
└── config.test.ts     # bun test suite
```

## License

MIT
