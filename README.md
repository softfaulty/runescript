# RuneScript

A DELTARUNE-specific desktop JavaScript executor built with Tauri 2, Rust,
Monaco, and JavaScriptCore. Bun runs the frontend tooling. JavaScript executes
inside the game, in a persistent JavaScriptCore context.

## Run

Requires macOS ARM64, Apple Command Line Tools, Bun, Rust, and the inspected
DELTARUNE runner with debugger access **and permission to load the agent dylib**.
The installed copy has been re-signed with debugger, agent loading, and JIT
entitlements with your permission. Restart the game for those permissions to
take effect. RuneScript itself does not silently re-sign games or change system protections.

```sh
bun install
bun run desktop
```

Inject bootstraps a Rust dylib with LLDB, then detaches the debugger. Run uses
the existing Unix socket and JavaScriptCore context. It does not attach LLDB,
reload the agent, or rescan the executable. The first attachment can briefly
pause the game.

```js
let x = 1;
```

On a later Run:

```js
x++;
console.log(x);
console.log(inspect.room());
console.log(native.Room_Number());
```

Reset Runtime removes callbacks and creates a new JavaScriptCore context while
keeping the agent and connection. Detach restores hooked functions and closes
the desktop connection. The dylib stays resident; Inject can reconnect to it.
Closing the desktop unexpectedly leaves the existing agent/runtime available.

## Real resources and hooks

Room names come from the active chapter's installed `game.ios`. Every room is
cross-checked against live `Room_Number`, `Room_Exists`, and `Room_Name` before
being exposed. No Chapter 1 room index is reused in another chapter.

```js
console.log(inspect.resources().filter(resource => resource.kind === 'room'));
// When the active chapter actually contains room_man:
// room_goto(room_man);
```

The first native hook target is the inspected
`Command_GotoRoom(int room, int transition)`, which `F_RoomGoto` calls.

```js
const handle = hooks.get('Command_GotoRoom').before(ctx => {
    console.log('Room request', ctx.args[0]);
    // Assign a discovered valid room index to ctx.args[0] to redirect it.
});
```

Remove on a later Run:

```js
handle.remove();
```

`before`, `after`, `replace`, and `around` callbacks run synchronously in-process.
`around` receives a single-use `ctx.next()`. The newest replacement owns the
call; before/after callbacks still run. A replacement that does not call an
original cancels the original operation. This function returns void, so no
meaningful native return value is advertised. `self`, `other`, and damage
fields are not invented.

Exceptions are reported to output. A failed callback falls back toward the
original call; arguments changed by a throwing callback are rolled back.
Calls from an unverified thread bypass JS. No hook invocation waits for desktop
IPC. Output is bounded (512 messages, 4 KiB per message between drains).

JavaScript defaults to a 100 ms execution budget per Run and a 5 ms budget for
hooks entered from gameplay. `inspect.setExecutionLimits(runMs, hookMs)` changes
subsequent execution budgets; zero disables the corresponding watchdog. These are watchdog limits, not real-time guarantees:
long native calls, allocation, garbage collection, or many hook invocations
can still stall a frame. Keep hook callbacks short. The watchdog uses the
system JavaScriptCore private execution-time API.

## Chapter changes and build verification

The agent tracks the runner's working directory. If it changes within the same
process, old callbacks are bypassed and the next session request reloads the
chapter resources and resets JavaScript. If DELTARUNE launches another process,
that process needs its own injection. Different processes cannot share a dylib
instance or JavaScriptCore heap.

The inspected runner fingerprint is
`9b21f9518fbbb4dbebbfb236899889bd410c8493716b5ced992b081ecd1f4810`.
A research copy with only a changed signature is accepted only if all ARM64
section contents, addresses, sizes, and symbols match a separately pinned
content digest. Unknown builds are rejected. Addresses are resolved from that executable's
Mach-O symbols plus its live ASLR slide, not guessed offsets.

The resource parser handles the installed chapter1–chapter5 datasets. This is
not a claim that every chapter has passed live hook testing; see
[verification](docs/verification.md) for actual results.

## Current boundaries

- Native/process integration is macOS ARM64 only. Windows is not implemented.
- Only room resources are exposed as globals. Other parsed resources are
  available as discovery records through `inspect.resources()`.
- Only the verified room call ABIs are callable. `native.symbol()` also allows
  exact Mach-O symbol inspection; addresses are hexadecimal strings.
- Damage, GML script dispatch, object events, instances, globals, and raw memory
  access are not exposed yet. `hooks.has('battle.applyDamage')` returns false.
- A room warp runs the real room-entry logic. It is not a save-state operation
  and does not remove cutscene/dialogue locks.
- Do not unload or replace the agent dylib in a live process. Restart the game
  after rebuilding native agent code.

## Code

- `src/`: TypeScript UI and Monaco configuration.
- `src-tauri/`: desktop commands and session ownership.
- `crates/session/`: IPC, macOS detection/bootstrap, fingerprinting, resource parser.
- `crates/agent/`: in-process runner, JavaScriptCore, hooks, and main-queue execution.

Frida Gum supplies native instruction relocation and hook restoration. Its
JavaScript engines are not enabled; RuneScript uses system JavaScriptCore.
The small `runtime.js` file defines host API objects and callback sequencing.
Hook registration, native interception, callback roots, and lifecycle live in Rust.

```sh
bun run build
cargo test -p runescript-agent -p runescript-session
DELTARUNE_RESOURCES='/path/to/DELTARUNE.app/Contents/Resources' \
  cargo test -p runescript-session --test chapters -- --ignored --nocapture
```

The CLI uses the same session implementation as Tauri:

```sh
target/debug/rsctl detect
target/debug/rsctl inject target/debug/librunescript_agent.dylib
target/debug/rsctl run 'console.log(inspect.room())'
target/debug/rsctl reset
target/debug/rsctl detach
```

Use one desktop/CLI connection at a time.
