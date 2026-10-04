import numpy as np
import pytest
from backend.edge.npu import windows, infer_series, suppress, SEQUENCE, STRIDE


def test_windows_preserve_upstream_clamping_and_unbiased_normalization():
    data = np.random.default_rng(7).normal(size=(12000, 3)).astype(np.float32)
    result = list(windows(data))
    assert [offset for offset, _ in result] == [0, STRIDE]
    for offset, wave in result:
        reference = data[
            np.clip(np.arange(SEQUENCE) + offset, 0, len(data) - 2)
        ].T.astype(np.float64)
        reference = reference - reference.mean(axis=1, keepdims=True)
        reference /= reference.std(axis=1, keepdims=True, ddof=1) + 1e-6
        np.testing.assert_allclose(wave, reference, rtol=1e-5, atol=1e-5)
    assert np.array_equal(result[-1][1][:, -1], result[-1][1][:, -2])


def test_station_batch_padding_cannot_create_phases_for_other_stations():
    class FakeNpu:
        batch, calls, seconds = 8, 0, 0

        def infer(self, data):
            assert data.shape == (8, 3, SEQUENCE)
            self.calls += 1
            result = np.zeros((8, 5, SEQUENCE), dtype=np.float32)
            for i in range(8):
                result[i, 1 + i % 4, 100 + 20 * i] = 0.9
            return result

    engine = FakeNpu()
    result, metrics = infer_series([np.ones((2000, 3)) for _ in range(3)], engine)
    assert len(result) == 3 and metrics["batches"] == 1
    assert [int(r[0, 0]) for r in result] == [0, 1, 2]
    assert [int(r[0, 1]) for r in result] == [100, 120, 140]
    assert all(len(r) == 1 for r in result)


def test_suppression_boundary_and_phase_independence():
    picks = suppress(
        [(0, 100, 0.8), (0, 400, 0.9), (0, 701, 0.7), (1, 401, 0.6), (0, 1001, 0.5)],
        1000,
    )
    assert set(map(tuple, picks[:, :2].astype(int))) == {(0, 400), (0, 701), (1, 401)}


def test_z_utc_window_works_on_python310():
    from backend.schemas import WindowInput

    window = WindowInput(
        start="2024-01-01T00:00:00Z",
        end="2024-01-01T00:03:00Z",
        station_ids=["XX.TEST."],
    )
    assert window.end.endswith("Z")
    with pytest.raises(ValueError):
        WindowInput(start=window.end, end=window.start, station_ids=window.station_ids)


def test_retention_preserves_event_and_manual_inputs(tmp_path, monkeypatch):
    import json, time
    from backend.config import settings
    from backend.db import init_db, connect
    from backend.edge.realtime import cleanup_completed_edge_inputs

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    init_db()
    cases = [
        ("automatic-empty", {"_precomputed_picks": "edge.csv"}, []),
        ("automatic-event", {"_precomputed_picks": "edge.csv"}, ["sx:real"]),
        ("manual-empty", {"station_ids": ["XX.TEST."]}, []),
    ]
    for job, payload, events in cases:
        directory = tmp_path / "runs" / job / "waveforms"
        directory.mkdir(parents=True)
        path = directory / "XX.TEST.mseed"
        path.write_bytes(b"evidence")
        with connect() as db:
            db.execute(
                "INSERT INTO jobs(id,kind,payload,status,result,created_at,updated_at) VALUES (?,?,?,'completed',?,?,?)",
                (
                    job,
                    "detect",
                    json.dumps(payload),
                    json.dumps({"events": events}),
                    "2020-01-01",
                    "2020-01-01",
                ),
            )
    cleanup_completed_edge_inputs(time.time())
    assert not (tmp_path / "runs/automatic-empty/waveforms").exists()
    assert (tmp_path / "runs/automatic-empty/inputs-expired.json").exists()
    assert (
        tmp_path / "runs/automatic-event/waveforms/XX.TEST.mseed"
    ).read_bytes() == b"evidence"
    assert (
        tmp_path / "runs/manual-empty/waveforms/XX.TEST.mseed"
    ).read_bytes() == b"evidence"
