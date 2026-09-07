import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import "./styles.css";

self.MonacoEnvironment = {
    getWorker: (_id, label) =>
        label === "typescript" || label === "javascript"
            ? new TypeScriptWorker()
            : new EditorWorker(),
};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const buttons = {
    inject: element<HTMLButtonElement>("inject"),
    detach: element<HTMLButtonElement>("detach"),
    reset: element<HTMLButtonElement>("reset"),
    run: element<HTMLButtonElement>("run"),
};

type GameProcess = { pid: number; path: string };
type Response = {
    result: string | null;
    error: string | null;
    output: string[];
    chapter: string | null;
    declarations: string | null;
};
type Request = { op: "status" | "reset" | "detach" | "output" } | { op: "run"; source: string };

let game: GameProcess | undefined;
let games: GameProcess[] = [];
const processPicker = element<HTMLSelectElement>("process");
let connected = false;
let busy = false;
let polling = false;
let declarations = "";
let library: monaco.IDisposable | undefined;
let lineCount = 0;

monaco.editor.defineTheme("runescript", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
        "editor.background": "#151515",
        "editorLineNumber.foreground": "#646464",
        "editor.lineHighlightBackground": "#1b1b1b",
        "editor.selectionBackground": "#38424e",
        "editorCursor.foreground": "#dedede",
    },
});

monaco.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    lib: ["esnext"],
});

let saved: string | null = null;
try {
    saved = localStorage.getItem("runescript.source");
} catch {}

const editor = monaco.editor.create(element("editor"), {
    value:
        saved ??
        '// Runs inside DELTARUNE. Variables persist until Reset Runtime.\nconsole.log(native.Room_Number());\nconsole.log(inspect.room());\n\n// Discover names before warping:\n// console.log(inspect.resources().filter(r => r.kind === "room"));\n',
    language: "javascript",
    theme: "runescript",
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "Menlo, Monaco, monospace",
    fontSize: 13,
    lineHeight: 21,
    padding: { top: 12 },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    tabSize: 4,
    bracketPairColorization: { enabled: false },
});

editor.onDidChangeModelContent(() => {
    try {
        localStorage.setItem("runescript.source", editor.getValue());
    } catch {}
});

function log(text: string, error = false) {
    const output = element("output");
    const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 30;
    const line = document.createElement("pre");
    line.textContent = text;
    if (error) line.className = "error";
    output.append(line);

    // console history is useful. a DOM with 40000 <pre>s is not.
    while (output.childElementCount > 1000) output.firstElementChild?.remove();
    element("line-count").textContent = String(++lineCount);
    if (follow) output.scrollTop = output.scrollHeight;
}

function controls() {
    processPicker.disabled = busy || connected;
    buttons.inject.disabled = busy || connected || !game;
    for (const button of [buttons.detach, buttons.reset, buttons.run])
        button.disabled = busy || !connected;

    element("status").textContent = busy
        ? "Working…"
        : connected
          ? "Injected"
          : game
            ? "Not injected"
            : "Not running";
    element("status").classList.toggle("connected", connected);
}

function response(value: Response) {
    for (const line of value.output) log(line);
    if (value.error) log(value.error, true);
    if (value.result && value.result !== "undefined") log(value.result);

    if (value.chapter)
        element("game").textContent =
            `DELTARUNE · ${value.chapter.replace(/^chapter(\d+)_mac$/, "Ch.$1")} · PID ${game?.pid ?? "—"}`;

    // the declarations only change when the runtime/chapter changes, so dont churn monaco
    if (value.declarations !== null && value.declarations !== declarations) {
        declarations = value.declarations;
        library?.dispose();
        library = monaco.typescript.javascriptDefaults.addExtraLib(
            declarations,
            "file:///runescript-runtime.d.ts",
        );
    }
}

async function perform(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    controls();

    try {
        await action();
    } catch (error) {
        log(String(error), true);
    } finally {
        busy = false;
        controls();
    }
}

async function request(request: Request) {
    try {
        response(await invoke<Response>("execute", { request }));
    } catch (error) {
        connected = false;
        library?.dispose();
        declarations = "";
        throw error;
    }
}

async function detect() {
    const detected = await invoke<GameProcess[]>("detect_game");
    if (detected.map(game => game.pid).join() !== games.map(game => game.pid).join()) {
        games = detected;
        game = games.find(candidate => candidate.pid === game?.pid) ?? games[0];
        processPicker.replaceChildren(...games.map(candidate => {
            const option = new Option(`PID ${candidate.pid}`, String(candidate.pid));
            option.title = candidate.path;
            return option;
        }));
        processPicker.value = String(game?.pid ?? "");
    }
    processPicker.hidden = games.length < 2;
    element("game").textContent = game ? `DELTARUNE · PID ${game.pid}` : "DELTARUNE";
    controls();
}

processPicker.onchange = () => {
    game = games.find(candidate => candidate.pid === Number(processPicker.value));
    element("game").textContent = game ? `DELTARUNE · PID ${game.pid}` : "DELTARUNE";
    controls();
};

buttons.inject.onclick = () =>
    void perform(async () => {
        if (!game) return;
        const result = await invoke<Response>("inject", { pid: game.pid });
        connected = true;
        response(result);
    });

buttons.detach.onclick = () =>
    void perform(async () => {
        await request({ op: "detach" });
        connected = false;
        library?.dispose();
        declarations = "";
    });

buttons.reset.onclick = () => void perform(() => request({ op: "reset" }));

const run = () => {
    if (connected) void perform(() => request({ op: "run", source: editor.getValue() }));
};

buttons.run.onclick = run;
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

element("clear").onclick = () => {
    element("output").replaceChildren();
    lineCount = 0;
    element("line-count").textContent = "0";
};

const splitter = element("splitter");
const resize = (height: number) =>
    document.documentElement.style.setProperty(
        "--output-height",
        `${Math.max(80, Math.min(window.innerHeight - 240, height))}px`,
    );

splitter.onpointerdown = (event) => {
    splitter.setPointerCapture(event.pointerId);
};

splitter.onpointermove = (event) => {
    if (splitter.hasPointerCapture(event.pointerId))
        resize(window.innerHeight - event.clientY - 49);
};

splitter.onkeydown = (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        resize(element("output-panel").clientHeight + (event.key === "ArrowUp" ? 20 : -20));
    }
};

void perform(detect);

// cheap status/output poll, busy/polling keeps it from stacking requests on a slow socket
setInterval(() => {
    if (busy || polling) return;
    polling = true;
    const poll = connected ? request({ op: "output" }) : detect();
    void poll
        .catch((error) => log(String(error), true))
        .finally(() => {
            polling = false;
            controls();
        });
}, 1000);
