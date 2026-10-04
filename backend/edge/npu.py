"""BMRuntime adapter and the pinned PNSN v3 window/normalization/NMS contract."""

import ctypes
import hashlib
from pathlib import Path
import fcntl
import time
from contextlib import contextmanager
import numpy as np
from ..config import settings

SEQUENCE = 10240
STRIDE = 9216
MIN_GAP = 300
THRESHOLD = 0.1


@contextmanager
def npu_lease(timeout=120):
    with (settings.data_dir / "npu.lock").open("a") as handle:
        until = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise TimeoutError("NPU 正忙，保留任务等待后续重试")
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class NativeEngine:
    def __init__(self, model=None, library=None):
        model = Path(model or settings.npu_model)
        self.model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
        self.lib = ctypes.CDLL(str(library or settings.npu_library))
        self.lib.sx_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
        self.lib.sx_open.restype = ctypes.c_void_p
        self.lib.sx_batch.argtypes = [ctypes.c_void_p]
        self.lib.sx_infer.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        self.lib.sx_close.argtypes = [ctypes.c_void_p]
        self.lib.sx_error.restype = ctypes.c_char_p
        with npu_lease():
            self.handle = self.lib.sx_open(str(model or settings.npu_model).encode(), 0)
        if not self.handle:
            raise RuntimeError(self.lib.sx_error().decode())
        self.batch = self.lib.sx_batch(self.handle)
        self.calls = 0
        self.seconds = 0.0

    def infer(self, data):
        if data.shape != (self.batch, 3, SEQUENCE):
            raise ValueError("NPU tensor must match the compiled batch")
        wave = np.ascontiguousarray(data, dtype=np.float32)
        output = np.empty((self.batch, 5, SEQUENCE), dtype=np.float32)
        with npu_lease():
            start = time.perf_counter()
            result = self.lib.sx_infer(
                self.handle, wave.ctypes.data, output.ctypes.data
            )
            self.seconds += time.perf_counter() - start
        self.calls += 1
        if result:
            raise RuntimeError(self.lib.sx_error().decode())
        if not np.isfinite(output).all():
            raise RuntimeError("NPU produced non-finite probabilities")
        return output

    def close(self):
        if self.handle:
            self.lib.sx_close(self.handle)
            self.handle = None


def windows(data):
    """Exactly match upstream clamping, channel order, demean and unbiased std."""
    length = len(data)
    if length < 2:
        return
    for offset in range(0, length, STRIDE):
        indices = np.clip(np.arange(SEQUENCE) + offset, 0, length - 2)
        wave = data[indices].T.copy().astype(np.float32)
        wave -= wave.mean(axis=1, keepdims=True)
        wave /= wave.std(axis=1, keepdims=True, ddof=1) + 1e-6
        yield offset, wave


def suppress(candidates, length):
    result = []
    for phase in range(4):
        rows = [r for r in candidates if r[0] == phase]
        rows.sort(key=lambda r: r[2], reverse=True)
        while rows:
            best = rows[0]
            if 0 <= best[1] < length:
                result.append(best)
            rows = [r for r in rows[1:] if abs(r[1] - best[1]) > MIN_GAP]
    return np.asarray(result, dtype=np.float32).reshape(-1, 3)


def infer_series(series, engine):
    """Pack windows from different stations together without mixing their signals."""
    candidates = [[] for _ in series]
    pending = []
    calls_before, seconds_before = engine.calls, engine.seconds

    def flush():
        batch = np.zeros((engine.batch, 3, SEQUENCE), np.float32)
        for i, (_, _, wave) in enumerate(pending):
            batch[i] = wave
        probabilities = engine.infer(batch)
        for i, (owner, offset, _) in enumerate(pending):
            for phase in range(4):
                values = probabilities[i, phase + 1]
                for sample in np.flatnonzero(values > THRESHOLD):
                    candidates[owner].append(
                        (phase, int(sample) + offset, float(values[sample]))
                    )
        pending.clear()

    for owner, data in enumerate(series):
        for offset, wave in windows(data):
            pending.append((owner, offset, wave))
            if len(pending) == engine.batch:
                flush()
    if pending:
        flush()
    return [suppress(c, len(data)) for c, data in zip(candidates, series)], {
        "batches": engine.calls - calls_before,
        "inference_seconds": engine.seconds - seconds_before,
        "station_windows": sum((len(d) + STRIDE - 1) // STRIDE for d in series),
        "batch_size": engine.batch,
        "backend": "BM1684X FP16",
        "model_sha256": getattr(engine, "model_sha256", None),
    }
