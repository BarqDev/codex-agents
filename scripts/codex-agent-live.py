#!/usr/bin/env python3
"""Live progress for codex-agent runs.

  codex-agent-live.py fmt RUNDIR [--echo]   turn `codex exec --json` events (stdin) into RUNDIR/progress.log
  codex-agent-live.py watch [NAME]          follow every active run live, one colored line per step
  codex-agent-live.py ps                    list recent runs with state and latest step

Each run lives in ~/.claude/cache/codex-runs/<id>/ with meta.json, status.json, progress.log, last.txt.
"""
import json, os, re, sys, time

RUNS = os.path.expanduser("~/.claude/cache/codex-runs")
COLORS = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92]


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def one_line(text, limit=220):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def unwrap_shell(cmd):
    # Codex runs commands as `/bin/zsh -lc "..."`; show just the inner command.
    m = re.match(r'^\S*/(?:ba|z)?sh -l?c (["\'])(.*)\1$', cmd or "", re.S)
    return m.group(2).replace('\\"', '"') if m else (cmd or "")


def fmt(rundir, echo):
    out = open(os.path.join(rundir, "progress.log"), "a", buffering=1)
    started = {}

    def emit(line):
        out.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        if echo:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()

    for raw in sys.stdin:
        try:
            ev = json.loads(raw)
        except ValueError:
            continue
        kind = ev.get("type", "")
        item = ev.get("item") or {}
        itype = item.get("type")
        if kind == "item.started":
            started[item.get("id")] = time.time()
            if itype == "command_execution":
                emit(f"$ {one_line(unwrap_shell(item.get('command')).replace(chr(10), ' ⏎ '), 160)}")
            elif itype == "mcp_tool_call":
                emit(f"🔧 {item.get('server', '')}.{item.get('tool', '')}")
            elif itype == "web_search":
                emit(f"🔎 {one_line(item.get('query'), 120)}")
        elif kind == "item.completed":
            took = time.time() - started.pop(item.get("id"), time.time())
            if itype == "agent_message":
                emit(f"💬 {one_line(item.get('text'))}")
            elif itype == "reasoning":
                emit(f"🧠 {one_line(item.get('text'), 160)}")
            elif itype == "command_execution":
                rc = item.get("exit_code")
                lines = [l for l in (item.get("aggregated_output") or "").splitlines() if l.strip()]
                tail = f" · {one_line(lines[-1], 100)}" if lines else ""
                emit(f"  {'✓' if rc == 0 else '✗'} exit {rc} · {took:.1f}s · {len(lines)} lines{tail}")
            elif itype == "file_change":
                files = ", ".join(f"{c.get('kind', '')} {os.path.basename(c.get('path', ''))}".strip()
                                  for c in item.get("changes") or [])
                emit(f"✎ {one_line(files, 160)}")
            elif itype == "todo_list":
                todo = item.get("items") or []
                done = sum(1 for t in todo if t.get("completed"))
                nxt = next((t.get("text") for t in todo if not t.get("completed")), "")
                emit(f"☐ plan {done}/{len(todo)}" + (f" · next: {one_line(nxt, 100)}" if nxt else ""))
            elif itype == "mcp_tool_call":
                emit(f"  {'✗' if item.get('error') else '✓'} {item.get('tool', '')} · {took:.1f}s")
            elif itype == "error":
                emit(f"⚠ {one_line(item.get('message'))}")
        elif kind == "turn.completed":
            u = ev.get("usage") or {}
            emit(f"■ tokens in {u.get('input_tokens', 0):,} (cached {u.get('cached_input_tokens', 0):,}) · out {u.get('output_tokens', 0):,}")
        elif kind in ("turn.failed", "error"):
            msg = (ev.get("error") or {}).get("message") if isinstance(ev.get("error"), dict) else ev.get("message")
            emit(f"⚠ {one_line(msg or json.dumps(ev))}")


def runs():
    try:
        names = sorted(os.listdir(RUNS))
    except OSError:
        return []
    return [os.path.join(RUNS, n) for n in names if os.path.isdir(os.path.join(RUNS, n))]


def elapsed(meta, status):
    end = status.get("ended") or time.time()
    s = int(end - meta.get("started", end))
    return f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


def ps():
    rows = runs()[-20:]
    if not rows:
        print("no codex-agent runs yet")
        return
    for d in rows:
        meta, status = load(os.path.join(d, "meta.json"), {}), load(os.path.join(d, "status.json"), {})
        last = ""
        try:
            with open(os.path.join(d, "progress.log")) as f:
                last = (f.readlines() or [""])[-1].strip()
        except OSError:
            pass
        print(f"{status.get('state', '?'):8} {meta.get('name', '?'):24} {elapsed(meta, status):>7}  {one_line(last, 90)}")


def watch(only):
    tracked = {}  # rundir -> [offset, color, announced_state]
    first = True
    print("Watching Codex agents (Ctrl-C to stop)…", flush=True)
    try:
        while True:
            for d in runs():
                meta = load(os.path.join(d, "meta.json"))
                if meta is None:
                    continue  # run dir created but meta.json not written yet
                status = load(os.path.join(d, "status.json"), {})
                name = meta.get("name", os.path.basename(d))
                if only and only not in name:
                    continue
                if d not in tracked:
                    # On startup, skip finished runs; afterwards every new run is shown.
                    if first and status.get("state") != "running":
                        tracked[d] = None
                        continue
                    color = COLORS[len(tracked) % len(COLORS)]
                    tracked[d] = [0, color, None]
                    where = meta.get("dir", "").replace(os.path.expanduser("~"), "~")
                    if len(where) > 60:
                        where = "…/" + "/".join(where.split("/")[-2:])
                    print(f"\033[1;{color}m▶ {name}\033[0m · {meta.get('model')} · {meta.get('effort')} · "
                          f"{meta.get('sandbox')} · {where}", flush=True)
                t = tracked[d]
                if t is None:
                    continue
                try:
                    with open(os.path.join(d, "progress.log")) as f:
                        f.seek(t[0])
                        chunk = f.read()
                        t[0] = f.tell()
                except OSError:
                    chunk = ""
                for line in chunk.splitlines():
                    print(f"\033[{t[1]}m{name:>18} │\033[0m {line}", flush=True)
                state = status.get("state")
                if state in ("done", "failed") and t[2] != state:
                    t[2] = state
                    mark = "\033[32m✓ done" if state == "done" else f"\033[31m✗ failed (exit {status.get('rc')})"
                    print(f"\033[1;{t[1]}m■ {name}\033[0m {mark}\033[0m in {elapsed(meta, status)}", flush=True)
            first = False
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fmt":
        fmt(sys.argv[2], "--echo" in sys.argv)
    elif cmd == "watch":
        watch(sys.argv[2] if len(sys.argv) > 2 else "")
    elif cmd == "ps":
        ps()
    else:
        print(__doc__)
        sys.exit(2)
