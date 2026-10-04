# BM1684X 边缘设备部署指南（社区版）

## 部署结构

本指南适用于具备 BM1684X、厂商 Linux 镜像与 libsophon runtime 的设备。路径、端口、账号均为通用示例，请按自己的机器调整。首次阅读请先看 [通用部署指南](portable-deployment.md)。源码不包含模型服务权重、厂商 SDK、NPU 编译产物或任何部署凭据。

应用、波形归档、NPU 检测、关联定位和 SQLite 数据库在设备运行；可选云服务器仅承担 HTTPS 中转。公开监测无需口令；后台 `/admin` 使用部署时自行初始化的账号。
```text
公共 SeedLink / FDSN
       ↓
8 路采集分片 → 有界批量归档 / SQLite WAL / 可恢复序号
       ↓
300 秒重叠窗口，每 60 秒一轮，完整三分量及新鲜度检查
       ↓
PNSN v3 → BM1684X FP16，批量 8 → 跨窗口震相去重
       ↓
重叠区域分组 → skill Python REAL → skill grid → 候选目录 / 人工复核

浏览器 → 可选云端 HTTPS :5012 → 回环 STCP visitor :15012
       → TLS 加密 FRP 通道 → 开发板 FastAPI :5012

目录统计 → 本地 Qwen3.5-2B（与拾取共享 NPU 调度锁）
         ↘ 独立配置的在线 OpenAI 兼容接口
```

历史验证设备为 8 核 ARM64、约 6 GB 主机内存、16 GB NPU 内存。其他配置需要重新测试容量。以下约定 `/data/seismicx/app` 为源码、`/data/seismicx/venv` 为 Python 环境、`/data/seismicx/runtime` 为数据、`/data/seismicx/models` 为 NPU 模型及适配器。Linux 服务账号请创建专用 `seismicx` 用户；不要默认使用设备登录账号或 root。

## 算法来源与 NPU 转换

继续使用固定的 `seismicx-catalog-skill`：

- 上游版本：`eebb87878ae27fbc8e33214c38c44fdeff9ba07b`
- 原始 PNSN v3 SHA256：`900dbf785d39b16fcaab5f53d04adddf6796b47f7aec17929abc6e7cfa5b2ddb`
- 历史验收 BModel SHA256：`ff196006b7c5d9068f0f5d1e1309fba33875ecd111d61042aced5d57399464e2`
- 历史编译环境：TPU-MLIR 1.30.2，BM1684X，FP16；SDK runtime 为板载 libsophon 0.5.1。

导出原 TorchScript 的稠密概率网络，预处理、滑窗、震相映射及后处理遵循 skill 合约：100 Hz、E/N/Z、10240 点、步长 9216、去均值、无偏标准差归一化、末端索引夹紧到 T−2、置信度阈值 0.1、同类相 300 点抑制距离。保留 skill 的 SNR 与初动极性函数。NPU 不可用时明确报错，不把 CPU 结果标成 NPU。

在具备 TPU-MLIR 的 x86_64 编译环境执行（编译环境另需安装 PyTorch、NumPy 和 `onnx`，不修改设备运行环境）：

```bash
python deploy/edge/export_pnsn.py \
  --model external/seismicx-catalog/assets/models/pnsn.v3.jit \
  --output pnsn_b8.onnx --batch 8
model_transform.py --model_name pnsn_b8 --model_def pnsn_b8.onnx \
  --input_shapes '[[8,3,10240]]' --test_input pnsn_b8_input.npz \
  --test_result onnx_reference.npz --mlir pnsn_b8.mlir
model_deploy.py --mlir pnsn_b8.mlir --quantize F16 --processor bm1684x \
  --test_input pnsn_b8_input.npz --test_reference onnx_reference.npz \
  --model pnsn_b8_f16.bmodel
```

将生成模型放到 `/data/seismicx/models/`，在开发板编译本项目的微型 C ABI 适配器，无需另装或替换厂商运行库：

```bash
g++ -std=c++17 -O3 -shared -fPIC deploy/edge/pnsn_runtime.cpp \
  -I/opt/sophon/libsophon-current/include \
  -L/opt/sophon/libsophon-current/lib \
  -Wl,-rpath,/opt/sophon/libsophon-current/lib -lbmrt -lbmlib \
  -o /data/seismicx/models/libseismicx_npu.so
```

不同编译器版本可能产生不同二进制，重新编译后必须重新做概率与真实震相对照。模型二进制、SDK、私钥均不提交 Git；上游 skill 的许可证仍适用。

## 安装与启动

1. 将本项目、`dist/` 和安装后的 `external/seismicx-catalog/` 放入 `/data/seismicx/app/`。前端在开发机执行 `npm ci && npm run build`。
2. 用板上的 Python 3.10 创建 `/data/seismicx/venv`。已有 ARM torch 时可用 `--system-site-packages` 复用；不要向原 Qwen 环境安装或升级依赖。新环境安装项目 `requirements.txt`，确认 `pymseed` 能解码 miniSEED 3。
3. 复制 `deploy/edge/edge.env.example` 为应用 `.env`，填写本地/在线模型地址，文件权限 600。在应用目录运行 `/data/seismicx/venv/bin/python scripts/admin_account.py` 初始化管理员。FRP 通道密钥仍独立保留。
4. 执行 `bash deploy/edge/install_services.sh /data/seismicx seismicx`。API、worker、collector、edge 为四个独立的 systemd 服务，重启自恢复，CPU 数学库线程数限制为 2。
5. 初次台站发现可预览再应用：

```bash
cd /data/seismicx/app
/data/seismicx/venv/bin/python -m deploy.edge.provision_live
/data/seismicx/venv/bin/python -m deploy.edge.provision_live --apply --max-stations 256
```

发现器核验 SeedLink INFO STREAMS 新鲜度、三分量和 FDSN 有效台站坐标；支持 GEOFON、BGR、INGV、INFP。已有人工坐标不被覆盖，不自动删除已有订阅。更多台网可在工作台管理，FDSN 还支持 EarthScope、SCEDC。

配置容量 256 是处理上限，不是承诺始终有 256 个完整且在线的公共台站。页面分别显示清单、订阅、采样、有效处理和延迟；过期、缺分量、缺口波形不补零冒充有效输入。

## 采集稳定性与资源控制

- 按台网/台站稳定哈希分配 8 个采集进程，各台保持独立游标；单服务可配置 1–8 分片。增加连接前应尊重数据提供方的连接限制。
- 每个进程的缓存最多 256 包或约 8 MB，正常每秒批量落盘；单包最多 4 MB。相邻采样合并再编码，显著减少小文件写入和 SQLite 提交。
- 波形字节先写出，在 Linux 上使用 `syncfs` 完成持久化，再以一个事务提交文件索引与采集游标。写盘失败不推进游标；各文件记录已提交字节边界，重启会先截掉未提交的尾部再重放，避免半条记录破坏归档。
- 元数据只存 SQLite WAL，原始 miniSEED 3 和兼容的 miniSEED 2 均归档。默认原始缓存保留 6 小时，边缘中间窗口保留 2 小时，总波形限制 12 GB；达到容量限制会暂停并暴露错误。
- 自动关联未产生目录事件的重复输入副本在 2 小时后清理，保留拾取、日志和过期记录；人工任务和已有事件的证据保留。
- 已进入候选目录的事件输入复制至 `runtime/runs/`，不会随短期缓存清理。该目录需定期人工归档；不能把它当成无限容量存储。
- NPU 跨进程文件锁协调本项目的本地 LLM 请求与震相推理；独立采集进程保持运行。其他项目直接调用 NPU 不受此锁管理。
- 连续处理当前只进行区域关联与定位。5° 重叠分区、默认区域均匀速度和边界深度仍需区域标定；原始震相不是已确认地震。

## 可选云服务器 HTTPS 中转

`deploy/edge/gateway/` 提供独立实例模板，禁止直接覆盖服务器其他项目的 FRP / nginx 配置。

1. 板端用已有 `frpc` 运行 STCP 代理，仅映射应用 5012；云端 visitor 仅监听 `127.0.0.1:15012`。两侧使用同一随机 STCP secret，连接既有 frps，开启 TLS，配置权限 600。
2. 分别创建 `seismicx-tunnel`（板端）和 `seismicx-visitor`（云端）服务，`ExecStart` 为对应 `frpc -c 配置路径`，`Restart=always`，随系统启动。
3. 云端 nginx 使用独立 `/opt/seismicx-gateway/nginx.conf`、PID 和日志。安全组开放 5012，以及 ACME HTTP-01 所需的 80；visitor 的 15012 无需公网开放。
4. 初次仅启用模板的 HTTP 80 ACME server，在 `/var/www/seismicx-acme` 提供验证目录。用 Certbot 5.8 的独立 venv 申请可信 IP 证书：

```bash
/opt/seismicx-gateway/venv/bin/certbot certonly --webroot \
  -w /var/www/seismicx-acme --ip-address YOUR_PUBLIC_IP \
  --preferred-profile shortlived --cert-name seismicx-ip \
  --agree-tos --register-unsafely-without-email --non-interactive
```

5. 启用模板中的 TLS 5012 server，`nginx -t -c /opt/seismicx-gateway/nginx.conf` 后启动独立服务。IP 证书有效期短，必须启用提供的 `seismicx-cert-renew.timer`（每 6 小时检查）并执行 `certbot renew --cert-name seismicx-ip --dry-run` 验证续签。80 端口与 ACME 路径需保持可达。

参考：[SeedLink 协议](https://docs.fdsn.org/projects/seedlink/en/latest/protocol.html)、[TPU-MLIR](https://github.com/sophgo/tpu-mlir)、[FRP visitor](https://gofrp.org/en/docs/reference/visitor/)、[Let’s Encrypt IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。

## 本地与在线 AI

NPU 示例配置预期另有 OpenAI 兼容模型服务监听 `http://127.0.0.1:8000/v1`、模型名 `qwen3.5-2b`。本仓库不自动安装该模型服务；先按厂商文档安装适配 BM1684X 的服务，使用 `GET /v1/models` 核对模型名，再填写实际地址。没有该模型也可以运行目录、采集与人工复核；AI 调用会明确提示不可用。在线服务通过 `SEISMICX_CLOUD_LLM_BASE_URL`、`SEISMICX_CLOUD_LLM_MODEL`、`SEISMICX_CLOUD_LLM_API_KEY` 单独配置。环境密钥更新后重启 API；已在后台保存的模型地址和名称会覆盖环境默认值，需同时在后台修改。工作台选择“本地小模型 / 开发板 2B”或“在线大模型”。未配置云服务时返回明确提示。

发送内容仅为统计摘要与用户问题。默认 2B 输出上限 512 tokens，总预算严格小于 8000；API 返回实际用量（服务支持时）。模型可能给出错误逻辑或单位解释，界面提示与确定性统计交叉核对，不允许从未知覆盖推断地震预测。

## 运维与复验

```bash
systemctl status seismicx-api seismicx-worker seismicx-collector seismicx-edge seismicx-tunnel
sudo journalctl -u seismicx-edge -n 100 --no-pager
# 公开可用性检查；详细 NPU 状态在登录后台后的边缘推理页查看。
curl http://127.0.0.1:5012/api/health
/data/seismicx/venv/bin/python -m pytest tests -q
OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 /data/seismicx/venv/bin/python \
  -m deploy.edge.validate_pnsn --waveforms /path/to/real/waveforms --output comparison.json
```

云端检查 `seismicx-gateway`、`seismicx-visitor` 和 `seismicx-cert-renew.timer`。忘记后台密码时，在板端应用目录运行 `scripts/admin_account.py` 重置，现有会话立即失效。算法和系统设置通过后台保存，覆盖同名环境默认值，不需重启服务；底层采集提供方、分片、密钥和 NPU 文件路径仍由部署环境管理。备份数据库应使用 SQLite backup API，并同时备份目录事件输入；不要直接复制正在写入的 WAL 数据库单文件。

实测数据见 [边缘验收记录](edge-validation.md)。公开服务可用性会变化，数十分钟实测不等同于全天候容量或生产地震定位精度验收。
