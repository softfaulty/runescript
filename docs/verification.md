# Verification

Development target: macOS ARM64, September 6, 2026.

## Previous evidence reused

`~/Reditlet-Rewrite/warp-room` and `warp-room.md` pin the runner fingerprint,
main-thread room warp ABI, and Chapter 1 room mapping. The old HP watchpoint
helper is not used as a damage hook.

Offline disassembly reconfirmed that `F_RoomGoto` converts its room argument
with `YYGetInt32`, loads `Transition_Kind`, then branches to
`Command_GotoRoom(int, int)`.

## Local checks

- TypeScript check and Vite production build passed.
- Native agent/session build passed.
- JavaScriptCore persistent lexical bindings, exception recovery, reset, and
  infinite-loop watchdog tests passed.
- Rust resource parser read installed room/object/sprite/sound/script tables:

| Data | Rooms | Parsed resources |
|---|---:|---:|
| Chapter 1 | 147 | 2436 |
| Chapter 2 | 278 | 6982 |
| Chapter 3 | 246 | 10118 |
| Chapter 4 | 328 | 11296 |
| Chapter 5 | 252 | 18613 |

Chapter 1 `room_man` resolved to 142. Chapter 5's directory is an installed
dataset, not a claim about that chapter's release/playability.

## Live tests

Initial inspection: PID 79700, `chapter2_mac`, current room 51. Its original
process rejected loading because of library validation. The installed app was
subsequently re-signed with authorized debugger, library-loading, and JIT
entitlements. That existing process has not been restarted or injected.

Live Chapter 1 tests passed on isolated copies (PIDs 28131 and 30742), with
Foundation's save directory redirected to a separate test home:

- Injected the Rust agent once; LLDB detached.
- Validated all 147 room names against the running game.
- Kept `let x = 1` between executions; the next execution returned 2.
- Hooked the native `Command_GotoRoom` function and changed requested room 141
  to 142. The actual current room became 142.
- Removed the callback; the same request then entered room 141.
- Installed another callback and redirected again without reinjection.
- Reset JavaScript, verified old bindings were gone, and installed another hook.
- Tested around-hook execution before and after the original call.

`tests/live.rs` repeated mutation, removal, reinstallation, and reset over one
GameSession and one UnixStream against the rebuilt agent in PID 30742. It passed
in 0.60 seconds. These calls enter the actual native function through RuneScript;
a player-triggered doorway hook has not yet been exercised. Other chapters have
passed resource parsing, but not this live lifecycle test. The damage path is
not mapped or exposed.

All eight original save/config file hashes matched the pre-test backup.
The original executable, Info.plist, and saves are backed up under
`.verification/backup/` (excluded from source control).

The packaged Tauri app was opened and visually checked: Monaco, process
detection, the resizable output panel, and disabled execution controls render
correctly. Generic callback dispatch tests cover argument mutation, replacement
cancellation, before-hook exception rollback, around/after order, and avoiding
a second original call after an around-hook exception. These are local tests,
not a substitute for the live milestone.
