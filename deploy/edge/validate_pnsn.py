"""Compare real-waveform picks against the unchanged upstream TorchScript picker."""

import argparse, json, time
from pathlib import Path
from datetime import datetime
from backend.edge.picker import skill_module, pick_files

parser = argparse.ArgumentParser()
parser.add_argument("--waveforms", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
skill = skill_module()
options = skill.build_parser().parse_args(
    ["pick", "-w", args.waveforms, "-o", "unused.csv", "--model", "pnsn-v3"]
)
paths = list(skill.iter_waveform_files(options.waveforms, options.extensions))
phases = {"PG", "SG", "PN", "SN"}
t = time.perf_counter()
cpu, cpu_errors = skill.torchscript_pnsn_pick_files(paths, phases, options)
cpu_s = time.perf_counter() - t
t = time.perf_counter()
npu, npu_errors = pick_files(paths, phases, options)
npu_s = time.perf_counter() - t
matches = []
unmatched = []
remaining = list(npu)
for p in cpu:
    candidates = [
        q
        for q in remaining
        if all(q[k] == p[k] for k in ["network", "station", "location", "phase"])
    ]
    if not candidates:
        unmatched.append(p)
        continue
    q = min(
        candidates,
        key=lambda q: abs(
            (
                datetime.fromisoformat(q["time"].replace("Z", "+00:00"))
                - datetime.fromisoformat(p["time"].replace("Z", "+00:00"))
            ).total_seconds()
        ),
    )
    delta = abs(
        (
            datetime.fromisoformat(q["time"].replace("Z", "+00:00"))
            - datetime.fromisoformat(p["time"].replace("Z", "+00:00"))
        ).total_seconds()
    )
    if delta > 0.1:
        unmatched.append(p)
    else:
        remaining.remove(q)
        matches.append(
            {
                "station": p["station"],
                "phase": p["phase"],
                "time_error_s": delta,
                "probability_error": abs(float(p["score"]) - float(q["score"])),
            }
        )
result = {
    "cpu_picks": len(cpu),
    "npu_picks": len(npu),
    "matched_within_100ms": len(matches),
    "cpu_seconds": cpu_s,
    "npu_seconds": npu_s,
    "max_time_error_s": max((x["time_error_s"] for x in matches), default=None),
    "max_probability_error": max(
        (x["probability_error"] for x in matches), default=None
    ),
    "cpu_errors": cpu_errors,
    "npu_errors": npu_errors,
    "unmatched_cpu": unmatched,
    "unmatched_npu": remaining,
    "matches": matches,
}
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(
    json.dumps(
        {
            k: v
            for k, v in result.items()
            if k not in ["matches", "unmatched_cpu", "unmatched_npu"]
        },
        ensure_ascii=False,
    )
)

if cpu_errors or npu_errors or unmatched or remaining:
    raise SystemExit("CPU/NPU phase comparison failed; inspect output report")
