# 在其他设备部署 SeismicX 社区版

本文对应 **2.1.0-community.1**：开发板阶段的 Python / SQLite 单机基线。通用 CPU 部署无需 NPU，也不依赖维护者的服务器、账号或内网。NPU 仅支持本版已有的 BM1684X 适配器，其他 NPU 需要自行适配，不能直接使用 BModel。版本范围见 [社区发布说明](community-release.md)。

## 1. 选择环境

| 设备 | 部署路径 | 说明 |
| --- | --- | --- |
| Linux x86_64 / ARM64 | Python 3.10–3.12 + CPU | 推荐 Ubuntu 22.04 / 24.04；确认所用 Python 有兼容的 PyTorch wheel |
| macOS Intel / Apple Silicon | Python 3.12 + CPU | 本版通用 CPU 路径，不包含后续 Metal / MLX 集成 |
| Windows | WSL2 Ubuntu，再执行 Linux 步骤 | 不支持原生 Windows Python，代码依赖 POSIX 文件锁 |
| BM1684X ARM64 开发板 | 厂商 Linux 镜像 + libsophon + NPU | 另见 [NPU 部署](edge-deployment.md) |
| Docker 主机 | Compose 三服务 | 普通 CPU 版本；不包含厂商驱动和模型服务 |

建议先为少量台站准备 4 核 CPU、8 GB 内存、20 GB 以上可用 SSD，再按采样率、通道数、保留时长和实测延迟调整。这是试运行资源建议，不是台站容量保证。模型下载和真实波形需要额外空间。公共数据服务必须能够从部署设备直接访问。

安装 Git、Python 及 venv、Node.js 22（建议 22.18 或更高补丁版）、npm。Debian / Ubuntu 通常还需要 `python3-venv`、`build-essential`、`libgomp1`。ARM 设备如果已有厂商 PyTorch，请使用独立环境，勿升级或破坏其他应用的运行库。检查：

```bash
python3.12 --version
node --version
npm --version
git --version
```

以下原生安装命令从项目目录执行；使用 Python 3.10 的设备把 `python3.12` 换成对应解释器。

## 2. 获取固定版本并安装

```bash
git clone https://github.com/cangyeone/seismicx-system.git
cd seismicx-system
git switch --detach v2.1.0-community.1
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
npm ci
.venv/bin/python scripts/install_algorithms.py
cp .env.example .env
chmod 600 .env
npm run build
.venv/bin/python scripts/admin_account.py
```

最后一步交互输入自己的管理员用户名和密码（至少 8 位）。没有预置账号；密码不写在命令行、Git 或前端。算法安装脚本下载固定的 catalog skill 版本，包含拾取、REAL 关联和网格定位所需入口；离线设备需要先在联网机器安装，再连同 `external/seismicx-catalog` 拷贝过去。不要把另一台机器的 `.venv` 直接复制过来。

`pip` 若找不到平台 wheel，应选择受支持的 Python / 操作系统组合，或遵循设备厂商的 PyTorch 安装方法，不要使用 `sudo pip` 覆盖系统环境。Linux CPU 可先按 [PyTorch 官方安装选择器](https://pytorch.org/get-started/locally/) 安装 CPU wheel，再安装项目依赖。

## 3. 启动与台站接入

```bash
.venv/bin/python scripts/start.py --port 8000 --collector fdsn
```

打开 `http://127.0.0.1:8000`，后台在 `/admin`，登录后的 API 文档在 `/api/admin/docs`。`Ctrl-C` 结束该启动器管理的 API、worker 和采集器。启动器适合试运行：一个子进程退出时会停止整组服务，不是长期运行的守护系统。

首次启动同步公共参考目录和台站清单。进入后台台站管理，先启用少量台站订阅；“清单数量”“订阅数量”“有新采样的在线台站数量”含义不同。历史波形下载不会冒充实时在线。首次检查：

```bash
curl --fail http://127.0.0.1:8000/api/health
```

健康接口返回 `2.1.0-community.1` 只说明 API 可用，还应在后台检查采集状态、最新采样时间和任务状态。需要局域网访问时显式加 `--host 0.0.0.0`，仅向可信网络开放所用端口；公网入口请使用 HTTPS 反向代理。

如改为 SeedLink，在 `.env` 设置数据提供方允许的地址，例如 `SEISMICX_SEEDLINK_SERVER=geofon.gfz.de:18000`，然后使用：

```bash
.venv/bin/python scripts/start.py --collector seedlink
```

同一数据目录不要同时启动两套采集器或 worker。普通 CPU 自动编目可以使用 FDSN 区域批处理：

```bash
.venv/bin/python scripts/start.py --collector fdsn --auto-catalog
```

CPU SeedLink 采集不会自动启动 NPU 推理；可从工作台提交检测任务，或使用上述 FDSN 自动编目。NPU 连续编目则需要独立启动 `backend.edge.realtime`，见 NPU 指南。默认速度和区域网格只是基线，必须按目标台网标定；所有自动结果为候选，需人工复核。

## 4. 本地小模型与在线接口

模型服务与本项目分别部署。可使用 Ollama 或其他提供 `/v1/chat/completions` 的兼容服务，先用其 `/v1/models` 确认实际模型名，再编辑 `.env`：

```dotenv
SEISMICX_LLM_BASE_URL=http://127.0.0.1:11434/v1
SEISMICX_LLM_MODEL=YOUR_LOCAL_MODEL_ID
SEISMICX_LLM_API_KEY=
SEISMICX_LLM_CONTEXT_TOKENS=7900
SEISMICX_LLM_OUTPUT_TOKENS=512
SEISMICX_BROADCAST_LLM_PROVIDER=local
SEISMICX_CLOUD_LLM_BASE_URL=
SEISMICX_CLOUD_LLM_MODEL=
SEISMICX_CLOUD_LLM_API_KEY=
```

先在模型服务侧准备模型；本项目不会替你下载 Qwen 权重或启动厂商模型服务。没有模型时波形、目录和统计仍可用，AI 会显示服务不可用。输入摘要与最大输出合计严格少于 8,000 tokens；模型自身上下文更小时还要降低预算。

首次环境配置后重启 API。如果已经在后台保存过设置，数据库中的设置优先于 `.env` 默认值，应在 `/admin` 的“系统与模型”同步修改地址、模型及演播来源。在线模型密钥只放服务端环境，不返回网页。Docker 中的 `127.0.0.1` 是容器自身；Docker Desktop 访问宿主机模型可使用 `host.docker.internal`，Linux 应配置可达的宿主机网关或独立模型服务网络。

AI 只根据目录统计和资料生成辅助报告，不是地震预测，也不会代替人工校正。

## 5. Docker Compose（CPU）

本路径与原生部署二选一。需要 Docker Engine / Docker Desktop 和 Compose 插件；无需宿主机安装 Node、Python 或算法环境。

```bash
cp .env.example .env
chmod 600 .env
docker compose config --quiet
docker compose build
docker compose run --rm --no-deps api python scripts/admin_account.py
docker compose up -d
docker compose ps
docker compose logs --tail=100 api worker collector
```

容器共享 `seismic-data` 命名卷，默认只监听宿主机 `127.0.0.1:8000`。保留 `.env` 中默认数据路径，不要把宿主机 `/data/...` 路径直接填入容器配置，否则可能写出挂载卷。要用 SeedLink，修改 `compose.yaml` 中 collector 的 `--mode` 参数，并设置 `.env` 的服务地址。默认 Compose 只采集，自动检测仍由后台提交；FDSN 自动检测可在 collector command 追加 `--auto-catalog`。

停止使用 `docker compose down`；**不要加 `-v`**，否则会删除命名卷及目录、账号和波形。Compose 的 `restart: unless-stopped` 恢复退出的进程；healthcheck 失败本身不会自动重启容器。本次社区打包未在 Docker daemon 上复验镜像，原生 Python 测试和前端构建记录见发布说明。

## 6. Linux 长期运行

CPU 设备可以分别创建 API、worker、collector 三个 systemd 服务。下面以 `/opt/seismicx` 源码目录、`/opt/seismicx/.venv` 环境、专用 `seismicx` 用户为例；先创建用户，并让它能读取源码、写入数据目录。不要与 root 交替运行同一数据目录。

在 `.env` 中使用绝对路径：

```dotenv
SEISMICX_DATA_DIR=/var/lib/seismicx
SEISMICX_SKILL_DIR=/opt/seismicx/external/seismicx-catalog
```

```bash
sudo useradd --system --home-dir /var/lib/seismicx --shell /usr/sbin/nologin seismicx
sudo install -d -o seismicx -g seismicx -m 700 /var/lib/seismicx
sudo chown root:seismicx /opt/seismicx/.env
sudo chmod 640 /opt/seismicx/.env
cd /opt/seismicx
sudo -u seismicx .venv/bin/python scripts/admin_account.py
```

账号已存在时跳过 `useradd`。如果原来用默认 `runtime/` 试运行，改路径会创建新数据库；要保留数据请按备份恢复步骤迁移整个数据目录，再初始化或使用原账号。

将以下保存为 `/etc/systemd/system/seismicx-api.service`：

```ini
[Unit]
Description=SeismicX community API
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=seismicx
Group=seismicx
WorkingDirectory=/opt/seismicx
Environment=PYTHONUNBUFFERED=1
Environment=OMP_NUM_THREADS=2
Environment=OPENBLAS_NUM_THREADS=2
ExecStart=/opt/seismicx/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
```

再复制为 `seismicx-worker.service` 和 `seismicx-collector.service`，修改 Description，并将 `ExecStart` 分别换成：

```text
/opt/seismicx/.venv/bin/python -m backend.worker
/opt/seismicx/.venv/bin/python -m backend.collector --mode fdsn
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now seismicx-api seismicx-worker seismicx-collector
sudo journalctl -u seismicx-collector -n 100 --no-pager
```

服务重启只能恢复进程退出，不能保证检测所有卡死或补回所有缺测。本版中断任务重启后标为失败，需人工重试。不要对所有 Python 进程执行批量终止。macOS 长期运行可自行建立对应 launchd 服务，或使用 Compose；本版不提供后续版本的专用 Mac mini 安装器。

## 7. BM1684X 设备准备

使用厂商系统确认 NPU 与 libsophon 可用后，按 [NPU 指南](edge-deployment.md) 转换 PNSN、编译适配器并校验精度。示例布局：

```text
/data/seismicx/app/       本仓库、dist、external
/data/seismicx/venv/      设备自己的 Python 环境
/data/seismicx/models/    pnsn_b8_f16.bmodel、libseismicx_npu.so
/data/seismicx/runtime/   SQLite、归档、任务产物
```

创建专用用户与目录，将源码安装到 `app`（前端可在开发机构建后传入），在设备上创建 venv 并安装依赖，复制 `deploy/edge/edge.env.example` 到 `app/.env`。确保专用服务用户能读取 `.env`、模型和算法，能写入 runtime。示例：

```bash
sudo chown -R seismicx:seismicx /data/seismicx
cd /data/seismicx/app
sudo -u seismicx /data/seismicx/venv/bin/python scripts/admin_account.py
bash deploy/edge/install_services.sh /data/seismicx seismicx
```

安装器使用 `venv`，不是 `.venv`，创建四个服务（API、worker、collector、edge）。API 默认仅监听回环 `127.0.0.1:5012`，由你自己的反向代理或隧道访问。缺模型、适配器、三分量或有效波形时会明确报错，不会声称正在 NPU 处理。

## 8. 公网、备份、升级和排障

- 公网使用你自己的域名 / 地址与 HTTPS。反向代理应保留包含端口的 Host、转发原始协议；仅信任实际代理地址，不要任意放开 forwarded headers。参见 [Uvicorn 代理说明](https://www.uvicorn.org/settings/#http) 和 [云中转模板](../deploy/edge/gateway)。模板中的占位符必须替换为自己的配置，并按本机 API 实际端口调整 8000 / 5012，不能直接运行。API 与同机代理建议都绑定回环。
- `.env`、密钥、数据库、备份与本地私密文档不提交 Git。公开浏览无需密码，后台必须登录。不要把原始 SQLite 数据目录映射成静态网站。
- 最简单的一致备份：先停止本项目所有服务，再将 **完整数据目录**、`.env` 和固定版本号复制到独立磁盘。包含 SQLite、波形、`runs` 及缓存；配置含凭据，备份权限应受控。在线备份应使用 SQLite backup API，不能仅复制正在写入的 `seismicx.sqlite3`。
- 恢复先停服务，使用同版本代码，将完整备份放回原绝对路径并恢复用户权限；确认数据库完整性、任务输入和波形可读后再启动。绝对路径发生变化时，历史记录中的路径可能失效，不能仅改环境变量就认为迁移成功。建议先在隔离数据副本演练。
- 升级前记录 `git describe --tags --always`、依赖、算法版本和数据路径，停止服务并备份。获取经审核的社区标签、重新安装依赖和构建，再启动服务。源码回退不等于数据库回退，恢复时使用配套数据备份。
- 本版短期波形缓存有年龄清理与容量限制，磁盘达到容量上限会暂停采集；不含新版外接盘循环归档。`runs/` 中事件证据需要单独人工归档，不能无限增长。磁盘满、网络断开、模型超时都应查对应服务日志。

故障定位：首页空白先查是否 `npm run build`；后台登录失败先查是否在正确数据目录初始化账号；站点无采样查订阅、提供方覆盖与最新采样时间；编目失败查后台任务日志及 `external/` 固定版本；NPU 错误查 SDK / BModel / 适配器；AI 无报告查模型服务与后台已保存配置。

## 9. 安装后验证

```bash
.venv/bin/python -m pytest tests -q
npm run test:map
npm run build
# 使用隔离数据目录运行真实历史数据验证，避免写入正式目录：
SEISMICX_DATA_DIR="$PWD/runtime/verification" .venv/bin/python scripts/real_smoke.py
```

真实数据验证会联网下载南加州六台历史波形并运行算法，需要已安装 skill 和 PyTorch，可能耗时数分钟；外部源不可达时记录失败，不应用模拟数据冒充通过。最后打开浏览器验证登录、台站订阅、事件波形、人工修改、演播及模型报告。历史 NPU 性能不等于当前设备实测吞吐。
