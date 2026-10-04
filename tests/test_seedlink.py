import struct
import pytest
from backend.seedlink4 import packet, MAX_PACKET_BYTES


class Socket:
    def __init__(self, data):
        self.data = data

    def recv(self, count):
        # Fragmented TCP reads, not assumed packet-aligned.
        part = self.data[: min(count, 3)]
        self.data = self.data[len(part) :]
        return part


def test_fragmented_frame():
    payload = b"waveform"
    sid = b"GE_MORC"
    frame = (
        b"SE2D" + struct.pack("<IQB", len(payload), 987654321, len(sid)) + sid + payload
    )
    assert packet(Socket(frame)) == (b"2D", "GE_MORC", 987654321, payload)


def test_packet_size_limit_and_disconnect():
    frame = b"SE2D" + struct.pack("<IQB", MAX_PACKET_BYTES + 1, 1, 0)
    with pytest.raises(ValueError):
        packet(Socket(frame))
    with pytest.raises(ConnectionError):
        packet(Socket(b"SE"))


def test_archive_checkpoint_follows_durable_bytes(tmp_path, monkeypatch):
    import numpy as np
    from obspy import Stream, Trace, UTCDateTime, read
    from backend.edge.archive import ArchiveBatch
    from backend.config import settings
    from backend.db import init_db, rows, state

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "edge_enabled", True)
    init_db()
    mapping = {"XX_TEST": [{"id": "XX.TEST.", "location": ""}]}

    def stream(start):
        return Stream(
            [
                Trace(
                    np.arange(100, dtype=np.int32),
                    header={
                        "network": "XX",
                        "station": "TEST",
                        "channel": "BHZ",
                        "sampling_rate": 100,
                        "starttime": UTCDateTime(start),
                    },
                )
            ]
        )

    batch = ArchiveBatch("example:18000")
    batch.add("XX_TEST", 10, stream(0), mapping)
    batch.add("XX_TEST", 11, stream(1), mapping)
    durable = ArchiveBatch.durable

    def fail(*args):
        assert state("seedlink-cursor:example:18000:XX_TEST") is None
        raise OSError("simulated storage failure")

    monkeypatch.setattr(ArchiveBatch, "durable", staticmethod(fail))
    with pytest.raises(OSError):
        batch.flush()
    assert rows("SELECT * FROM waveform_files") == []
    assert state("seedlink-cursor:example:18000:XX_TEST") is None
    monkeypatch.setattr(ArchiveBatch, "durable", staticmethod(durable))
    batch.flush()
    assert state("seedlink-cursor:example:18000:XX_TEST") == {"sequence": 11}
    archived = read(rows("SELECT path FROM waveform_files")[0]["path"]).merge()
    assert archived[0].stats.npts == 200  # crash replay is idempotent on read
    assert batch.count == 0
    # Emulate a process dying halfway through the next record; a fresh writer
    # must discard that uncommitted tail before replaying from saved sequence 11.
    path = tmp_path / "waveforms" / "XX.TEST..BHZ-0.mseed"
    with path.open("ab") as output:
        output.write(b"partial-record")
    resumed = ArchiveBatch("example:18000")
    resumed.add("XX_TEST", 12, stream(2), mapping)
    resumed.flush()
    assert read(str(path)).merge()[0].stats.npts == 300
    assert state("seedlink-cursor:example:18000:XX_TEST") == {"sequence": 12}


def test_archive_rejects_wrong_location_without_advancing_cursor(tmp_path, monkeypatch):
    from obspy import Stream, Trace
    import numpy as np
    from backend.edge.archive import ArchiveBatch
    from backend.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "edge_enabled", True)
    batch = ArchiveBatch("example")
    stream = Stream([Trace(np.ones(100), header={"location": "10"})])
    with pytest.raises(ValueError):
        batch.add(
            "XX_TEST", 1, stream, {"XX_TEST": [{"id": "XX.TEST.", "location": ""}]}
        )
    assert batch.count == 0 and batch.cursors == {}
