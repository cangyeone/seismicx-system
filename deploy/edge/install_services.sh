#!/usr/bin/env bash
# Run on the board after app, venv, model and private .env are installed.
set -euo pipefail
root_dir=${1:-/data/seismicx}
service_user=${2:-seismicx}
test -x "$root_dir/venv/bin/python"
test -s "$root_dir/app/.env"
chmod 600 "$root_dir/app/.env"
for name in api worker collector edge; do
  case "$name" in
    api) module='uvicorn backend.app:app --host 127.0.0.1 --port 5012 --no-access-log' ;;
    worker) module='backend.worker' ;;
    collector) module='backend.collector --mode seedlink' ;;
    edge) module='backend.edge.realtime' ;;
  esac
  cat <<EOF | sudo tee "/etc/systemd/system/seismicx-$name.service" >/dev/null
[Unit]
Description=SeismicX edge $name
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$root_dir
[Service]
Type=simple
User=$service_user
WorkingDirectory=$root_dir/app
Environment=OMP_NUM_THREADS=2
Environment=OPENBLAS_NUM_THREADS=2
Environment=MKL_NUM_THREADS=2
Environment=NUMBA_NUM_THREADS=2
Environment=PYTHONUNBUFFERED=1
ExecStart=$root_dir/venv/bin/python -m $module
Restart=always
RestartSec=5
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
done
sudo systemctl daemon-reload
sudo systemctl enable --now seismicx-api seismicx-worker seismicx-collector seismicx-edge
