"""Reuse the pinned skill data contract and scientific helpers with NPU inference."""

import importlib.util
import sys
import numpy as np
from ..config import settings
from ..db import state, now
from .npu import NativeEngine, infer_series

_engine = None
_skill = None


def skill_module():
    global _skill
    if _skill is None:
        path = settings.skill_dir / "scripts/seismicx_catalog.py"
        sys.path.insert(0, str(path.parent))
        spec = importlib.util.spec_from_file_location("seismicx_catalog_edge", path)
        _skill = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = _skill
        spec.loader.exec_module(_skill)
    return _skill


def pick_files(paths, requested, args):
    global _engine
    import time
    from obspy import Stream, read
    from pathlib import Path
    from concurrent.futures import ThreadPoolExecutor

    skill = skill_module()
    if _engine is None:
        _engine = NativeEngine()
    started = time.perf_counter()

    def read_input(path, headonly=False):
        if Path(path).suffix.lower() in {".mseed", ".msd", ".miniseed"}:
            return read(str(path), format="MSEED", headonly=headonly)
        return skill.read_waveform(path, headonly=headonly)

    grouped = {}
    errors = []
    for path in paths:
        try:
            for trace in read_input(path, headonly=True):
                if skill.component_family(trace.stats.channel):
                    grouped.setdefault(skill.station_day_key(trace), set()).add(
                        str(path)
                    )
        except Exception as exc:
            errors.append({"path": str(path), "error": str(exc)})
    groups = []
    series = []

    def prepare_group(item):
        key, sources = item
        try:
            stream = Stream()
            for source in sorted(sources):
                stream += Stream(
                    [t for t in read_input(source) if skill.matches_station_day(t, key)]
                )
            # As in the skill: no bandpass, same resampling and component mapping.
            stream.merge(fill_value=0)
            stream.resample(100)
            components = skill.select_three_components(stream)
            if not components:
                raise ValueError("missing E/N/Z components")
            start = min(t.stats.starttime for _, t in components)
            end = max(t.stats.endtime for _, t in components)
            arrays = []
            traces = {}
            for family, trace in components:
                tr = trace.copy().trim(
                    starttime=start, endtime=end, pad=True, fill_value=0
                )
                tr.detrend("demean")
                arrays.append(np.asarray(tr.data, dtype=np.float32))
                traces[family] = tr
            length = min(map(len, arrays))
            if length < 2:
                raise ValueError("三分量时间窗过短")
            return (
                (key, sources, start, traces),
                np.stack([a[:length] for a in arrays], axis=1),
                None,
            )
        except Exception as exc:
            return (
                None,
                None,
                {"path": skill.join_waveform_paths(sources), "error": str(exc)},
            )

    # Fourier resampling dominates CPU time. Independent station groups can use
    # separate cores without changing sample values or the scientific contract.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for group, data, error in pool.map(prepare_group, grouped.items()):
            if error:
                errors.append(error)
            else:
                groups.append(group)
                series.append(data)
    outputs, metrics = infer_series(series, _engine)
    picks = []
    for (key, sources, start, traces), data, output in zip(groups, series, outputs):
        network, station, location, _ = key
        z = traces["Z"]
        prepared = None
        for phase_index, sample, score in output:
            phase = skill.PNSN_PHASE_MAP[int(phase_index)]
            if phase.upper() not in requested:
                continue
            sample = int(round(float(sample)))
            arrival = start + sample / 100
            polarity, quality, polarity_score = "N", "", 0.0
            if skill.phase_group(phase) == "P":
                if prepared is None:
                    prepared = skill.prepare_first_motion_trace(z)
                polarity, quality, polarity_score = skill.estimate_first_motion(
                    z,
                    arrival,
                    min_score=args.polarity_min_score,
                    prepared_trace=prepared,
                )
            picks.append(
                {
                    "pick_id": f"p{len(picks) + 1:08d}",
                    "event_id": "",
                    "waveform_path": skill.join_waveform_paths(sources),
                    "trace_id": skill.station_id(network, station, location) + ".3C",
                    "network": network,
                    "station": station,
                    "location": location,
                    "channel": "3C",
                    "phase": phase,
                    "time": skill.datetime_to_text(arrival.datetime),
                    "score": f"{float(score):.6g}",
                    "snr": str(
                        skill.estimate_pick_snr(
                            data[:, 2],
                            sample,
                            100,
                            args.noise_window,
                            args.signal_window,
                        )
                    ),
                    "amplitude": str(
                        float(
                            np.max(
                                np.abs(
                                    data[
                                        sample : min(
                                            len(data),
                                            sample + int(args.signal_window * 100),
                                        ),
                                        2,
                                    ]
                                )
                            )
                        )
                    ),
                    "polarity": polarity,
                    "polarity_quality": quality,
                    "polarity_score": str(polarity_score),
                    "picker": "PNSN v3 / BM1684X FP16",
                }
            )
    state(
        "npu",
        {
            "heartbeat": now(),
            **metrics,
            "stations": len(series),
            "picks": len(picks),
            "preprocess_and_infer_seconds": time.perf_counter() - started,
            "errors": errors[:8],
        },
    )
    return picks, errors


def run_pick(arguments):
    skill = skill_module()
    parser = skill.build_parser()
    args = parser.parse_args([str(a) for a in arguments])
    paths = list(skill.iter_waveform_files(args.waveforms, args.extensions))
    picks, errors = pick_files(paths, {p.upper() for p in args.phases.split(",")}, args)
    fields = [
        "pick_id",
        "event_id",
        "waveform_path",
        "trace_id",
        "network",
        "station",
        "location",
        "channel",
        "phase",
        "time",
        "score",
        "snr",
        "amplitude",
        "polarity",
        "polarity_quality",
        "polarity_score",
        "picker",
    ]
    skill.write_csv_rows(args.output, picks, fields)
    if args.errors:
        skill.write_csv_rows(args.errors, errors, ["path", "error"])
    if errors and not picks and len(errors) >= len(paths):
        raise RuntimeError("NPU拾取输入失败：" + str(errors[:3]))
    return picks
