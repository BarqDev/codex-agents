#!/usr/bin/env python3
"""Model and quota lookups for codex-agent.

  codex-agent-models.py model CACHE TIER   newest listed model of a tier (sol, terra, luna)
  codex-agent-models.py models CACHE       every model in the catalog, by priority
  codex-agent-models.py limits ROLLOUT     the latest weekly-usage snapshot in a session log

A script file rather than heredocs in codex-agent: bash writes each heredoc to a temp file,
which a read-only sandbox refuses, so the wrapper failed inside a read-only Codex agent.
"""
import json, os, re, sys, time


def family(slug):
    m = re.match(r"gpt-([\d.]+)-([a-z]+)$", slug)
    # Pad so "6" compares as 6.0.0 and sorts below "6.1".
    return (m.group(2), tuple((list(map(int, m.group(1).split("."))) + [0, 0, 0])[:3])) if m else (None, ())


# Tiers are model families: astra (frontier, never auto-picked), sol (workhorse), terra (mid), luna (fast).
# A tier resolves to the newest listed model of its family (highest version, then catalog priority).
def model(cache, tier):
    tier = {"top": "sol", "mid": "terra", "fast": "luna"}.get(tier.lower(), tier.lower())
    if tier == "astra":
        sys.exit("codex-agent: the astra tier is never auto-picked; pass -m with its slug if the user asked for it")
    models = [m for m in json.load(open(cache))["models"]
              if m.get("visibility") == "list" and m.get("supported_in_api")]
    pool = [m for m in models if family(m["slug"])[0] == tier]
    if not pool:
        sys.exit(f"codex-agent: no listed model in tier '{tier}' (tiers: sol, terra, luna)")
    pool.sort(key=lambda m: (tuple(-v for v in family(m["slug"])[1]), m.get("priority", 999)))
    print(pool[0]["slug"])


def models(cache):
    for m in sorted(json.load(open(cache))["models"], key=lambda m: m.get("priority", 999)):
        print(f'{m["slug"]:22} prio={m.get("priority")} vis={m.get("visibility")}  {m.get("description","")}')


def limits(rollout):
    def find(o):
        if isinstance(o, dict):
            if isinstance(o.get("rate_limits"), dict):
                return o["rate_limits"]
            for v in o.values():
                x = find(v)
                if x:
                    return x
    r = None
    for line in open(rollout):
        if '"rate_limits"' in line:
            r = find(json.loads(line)) or r
    p = r.get("primary") or {}
    print(f'plan={r.get("plan_type")} weekly_used={p.get("used_percent")}% window={p.get("window_minutes")}min '
          f'resets={time.strftime("%Y-%m-%d %H:%M", time.localtime(p.get("resets_at", 0)))} '
          f'credits={(r.get("credits") or {}).get("balance")} reached={r.get("rate_limit_reached_type")}')
    print("snapshot age:", int((time.time() - os.path.getmtime(rollout)) / 60), "min")


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if cmd == "model" and len(args) == 2:
        model(*args)
    elif cmd == "models" and len(args) == 1:
        models(*args)
    elif cmd == "limits" and len(args) == 1:
        limits(*args)
    else:
        print(__doc__)
        sys.exit(2)
