#!/usr/bin/env python3
"""Run a task inside the ChatGPT app's own Codex, so it can drive the user's Chrome.

  codex-agent-bridge.py run --bin CODEX --runs DIR --name NAME [--echo] [--out FILE] < prompt
  codex-agent-bridge.py threads

Only the ChatGPT app gives its Codex access to the "ChatGPT for Chrome" extension, and the app
runs a message queued into one of its own threads (`codex queue`). So browser tasks go to a pool
of threads the user creates once in the app, named "Claude bridge", "Claude bridge 2", and so on.
Each task takes a free thread (a lock per thread), is queued with a unique marker, and is followed
in that thread's session log until its turn completes; the turn's last message is the answer.
The run is recorded in the same run folders as codex-agent runs, so ps, watch and the panel show it.
"""
import argparse, glob, json, os, re, subprocess, sys, time, uuid

CODEX = os.path.expanduser("~/.codex")
LOCKS = os.path.expanduser("~/.claude/cache/codex-bridge")
NAME = re.compile(r"^claude bridge(?: \d+)?$", re.I)
PICKUP_S = 120          # the app should start the turn this soon, or it is not open
TASK_S = 90 * 60        # longest a browser task may run
WAIT_FREE_S = 30 * 60   # longest to wait for a free bridge thread


def threads():
    """Bridge threads by name, from the session index (its last entry per thread wins)."""
    names = {}
    try:
        for line in open(os.path.join(CODEX, "session_index.jsonl")):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("id"):
                names[e["id"]] = e.get("thread_name") or ""
    except OSError:
        return []
    found = [(n.strip(), t) for t, n in names.items() if NAME.match(n.strip())]
    return [(t, n) for n, t in sorted(found, key=lambda x: (len(x[0]), x[0].lower()))]


def rollout(tid):
    files = glob.glob(os.path.join(CODEX, "sessions", "**", f"*{tid}.jsonl"), recursive=True)
    return max(files, key=os.path.getmtime) if files else None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def try_lock(tid):
    path = os.path.join(LOCKS, f"{tid}.lock")
    for _ in range(2):
        try:
            os.mkdir(path)
            with open(os.path.join(path, "pid"), "w") as f:
                f.write(str(os.getpid()))
            return path
        except FileExistsError:
            try:
                pid = int(open(os.path.join(path, "pid")).read().strip())
            except (OSError, ValueError):
                pid = 0
            if pid and alive(pid):
                return None
            # No pid yet: another run made the lock a moment ago and is still writing it.
            try:
                if not pid and time.time() - os.path.getmtime(path) < 30:
                    return None
            except OSError:
                continue
            # The run holding it is gone: take the thread over.
            for f in os.listdir(path):
                os.remove(os.path.join(path, f))
            os.rmdir(path)
    return None


def unlock(path):
    try:
        for f in os.listdir(path):
            os.remove(os.path.join(path, f))
        os.rmdir(path)
    except OSError:
        pass


def one_line(text, limit=220):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Run:
    """A run folder shaped like codex-agent's, so ps, watch and the panel read it."""

    def __init__(self, runs, name, echo, prompt):
        os.makedirs(runs, exist_ok=True)
        slug = re.sub(r"[^A-Za-z0-9_-]", "", name) or "browser"
        self.dir = os.path.join(runs, f"{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}-{slug}")
        os.makedirs(self.dir)
        self.echo = echo
        self.meta = {"name": name, "model": "chatgpt-app", "effort": "app", "sandbox": "your Chrome",
                     "dir": os.getcwd(), "pid": os.getpid(), "started": time.time()}
        self._write("meta.json", self.meta)
        self._write("status.json", {"state": "running"})
        open(os.path.join(self.dir, "prompt.txt"), "w").write(prompt)
        self.log = open(os.path.join(self.dir, "progress.log"), "a", buffering=1)

    def _write(self, name, value):
        json.dump(value, open(os.path.join(self.dir, name), "w"))

    def emit(self, line):
        self.log.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        if self.echo:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()

    def end(self, rc, answer):
        open(os.path.join(self.dir, "last.txt"), "w").write(answer)
        self._write("status.json", {"state": "done" if rc == 0 else "failed", "rc": rc, "ended": time.time()})


def follow(path, offset, marker, run):
    """Follow a thread's log from `offset`; return (rc, answer) once the marked turn completes."""
    seen = False
    pickup_by = time.time() + PICKUP_S
    done_by = time.time() + TASK_S
    pending = ""
    last_text = ""
    while True:
        with open(path) as f:
            f.seek(offset)
            chunk = f.read()
            offset = f.tell()
        pending += chunk
        lines = pending.split("\n")
        pending = lines.pop()
        for raw in lines:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            kind, p = e.get("type"), e.get("payload") or {}
            ptype = p.get("type")
            if kind == "response_item" and ptype == "message":
                text = "".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict))
                if p.get("role") == "user" and marker in text:
                    seen = True
                    run.emit("💬 The ChatGPT app picked up the task")
                elif seen and p.get("role") == "assistant" and text.strip() and not text.startswith("::"):
                    last_text = text
                    run.emit(f"💬 {one_line(text)}")
            elif not seen:
                continue
            elif kind == "response_item" and ptype == "function_call":
                try:
                    args = json.loads(p.get("arguments") or "{}")
                except ValueError:
                    args = {}
                run.emit(f"$ {one_line(args.get('title') or p.get('name') or 'tool call', 160)}")
            elif kind == "response_item" and ptype == "function_call_output":
                run.emit("  ✓ step done")
            elif kind == "event_msg" and ptype == "task_complete":
                answer = (p.get("last_agent_message") or last_text or "").strip()
                return (0, answer) if answer else (1, "The ChatGPT app finished the task without an answer.")
            elif kind == "event_msg" and ptype in ("turn_aborted", "error"):
                return 1, f"The ChatGPT app stopped the task ({ptype}): {one_line(json.dumps(p), 300)}"
        now = time.time()
        if not seen and now > pickup_by:
            return 1, ("The ChatGPT app did not pick up the task within 2 minutes. Is the ChatGPT app "
                       "open and signed in? The task is still queued in its bridge thread.")
        if now > done_by:
            return 1, "The browser task ran over 90 minutes; it may still be running in the ChatGPT app."
        time.sleep(1)


def run_task(args):
    prompt = sys.stdin.read().strip()
    run = Run(args.runs, args.name, args.echo, prompt)
    pool = threads()
    if not pool:
        msg = ('No bridge thread found. In the ChatGPT app, start a Codex thread, send it any message, '
               'and rename it "Claude bridge" (add "Claude bridge 2", "Claude bridge 3" ... to run '
               'browser tasks in parallel).')
        run.emit(f"⚠ {msg}")
        run.end(1, msg)
        print(msg, file=sys.stderr)
        return 1

    os.makedirs(LOCKS, exist_ok=True)
    lock = tid = None
    waited = False
    give_up = time.time() + WAIT_FREE_S
    while lock is None:
        for t, n in pool:
            lock = try_lock(t)
            if lock:
                tid, label = t, n
                break
        if lock is None:
            if time.time() > give_up:
                msg = f"Every bridge thread ({len(pool)}) stayed busy for 30 minutes."
                run.end(1, msg)
                print(msg, file=sys.stderr)
                return 1
            if not waited:
                run.emit(f"☐ all {len(pool)} bridge threads are busy; waiting for one")
                waited = True
            time.sleep(3)

    try:
        if args.echo:
            sys.stderr.write(f"▶ chatgpt-app · your Chrome · {label}\n")
        path = rollout(tid)
        if not path:
            msg = f'The session log of "{label}" was not found; send it a message in the ChatGPT app once.'
            run.end(1, msg)
            print(msg, file=sys.stderr)
            return 1
        offset = os.path.getsize(path)
        marker = f"[claude-task {uuid.uuid4().hex[:12]}]"
        message = (f"{marker} New, independent task from Claude. Ignore earlier tasks in this thread. "
                   "Use the user's Chrome through your browser tools when the task needs a browser.\n\n"
                   f"{prompt}\n\nEnd with your complete answer as your final message.")
        q = subprocess.run([args.bin, "queue", "--thread", tid, "--message", message],
                           capture_output=True, text=True, timeout=60)
        if q.returncode != 0:
            msg = f"Could not queue the task: {one_line(q.stderr or q.stdout, 400)}"
            run.end(1, msg)
            print(msg, file=sys.stderr)
            return 1
        run.emit(f"☐ queued in {label}")
        rc, answer = follow(path, offset, marker, run)
        run.emit("■ done" if rc == 0 else f"⚠ {one_line(answer)}")
        run.end(rc, answer)
        if rc != 0:
            print(answer, file=sys.stderr)
            return rc
        if args.out:
            open(args.out, "w").write(answer)
        print(answer)
        return 0
    finally:
        unlock(lock)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "threads"])
    ap.add_argument("--bin")
    ap.add_argument("--runs")
    ap.add_argument("--name", default="browser")
    ap.add_argument("--out")
    ap.add_argument("--echo", action="store_true")
    a = ap.parse_args()
    if a.cmd == "threads":
        for t, n in threads():
            print(f"{t}  {n}")
        sys.exit(0)
    sys.exit(run_task(a))
