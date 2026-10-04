# SeismicX 边缘推理平台 · 社区版

Python 为核心的地震监测与自动编目系统：全球公共台站与地震目录展示、FDSN / SeedLink 波形接入、PNSN 震相拾取、REAL 关联、网格定位、人工复核、历史事件回放与小模型分析。

**版本：2.1.0-community.1（2026-10-03 开发板阶段基线）。** 本仓库发布可独立部署的旧版社区快照，与后续优化版本保持版本差，不自动同步最新版代码或提交历史。范围见 [版本说明](docs/community-release.md)。

支持 Linux / macOS CPU 和 BM1684X 开发板 NPU。首次安装请按 [其他设备部署指南](docs/portable-deployment.md) 操作；NPU 转换和服务安装见 [边缘部署指南](docs/edge-deployment.md)，历史实测见 [边缘验收](docs/edge-validation.md)。Windows 请使用 WSL2 Linux，本版代码使用 POSIX 文件锁，不支持原生 Windows Python。

这是可运行的本地/单机部署版本。全球台网的地图与波形接入已经实现；自动定位使用**区域模型**，必须按区域分组并验证速度模型。自动产物始终标为候选，不把外部 USGS 目录当作本系统检测结果。

## 快速启动

需要 Python 3.10–3.12、Node.js 22、Git。推荐 macOS/Linux。

```bash
git clone https://github.com/cangyeone/seismicx-system.git
cd seismicx-system
git switch --detach v2.1.0-community.1
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
.venv/bin/python scripts/install_algorithms.py
cp .env.example .env
npm run build
.venv/bin/python scripts/admin_account.py
.venv/bin/python scripts/start.py
```

打开 <http://127.0.0.1:8000>；登录后台后 API 文档为 <http://127.0.0.1:8000/api/admin/docs>。`Ctrl-C` 终止启动器管理的进程。默认同步 USGS M2.5+ 过去一天目录和 EarthScope IU/II 台站。台站清单不等于在线台站；在台站页启用订阅后，采集器收到采样才显示在线。

开发时分别运行 `npm run dev`、`npm run api`、`.venv/bin/python -m backend.worker` 和 `.venv/bin/python -m backend.collector --mode fdsn`。Vite 只负责界面，API/模型/数据处理均在 Python 中运行。原 `server.ts`、旧采集器和旧 `src/components` 保留作历史参考，不再是启动入口。

## 功能与工作流

- **监测总览**：全球地图、台站数量、在线状态、实时参考目录、候选事件、真实采样延迟。
- **台站管理**：增加台站、启停订阅、连续三分量波形；SCEDC、EarthScope、GEOFON FDSN 支持独立选择。台站配置也可通过 PATCH API 修改。
- **自动编目**：选择区域台站与 UTC 时间窗 → 下载原始 miniSEED → skill scan → 未滤波 PNSN v3 → Python REAL → skill grid location → 保存候选事件、震相、QC 与运行记录。
- **人工复核**：震中距–时间波形支持以鼠标为中心滚轮缩放、滚动条平移；点击波形打开单台三分量窗口，Ctrl+1…6 切换 Pg/Sg/Pn/Sn/P/S，拖动调整或删除已有震相。可精确修改到时、震级及位置，右侧显示定位结果；修改后重新进入待复核状态。详见 [复核与目录分析](docs/review-analysis.md)。
- **震级计算**：可调用 skill 的 seedtools DD1 ML，自动下载事件时段 StationXML 响应，选择 R11–R15 区域曲线；至少两台响应标定成功才写入候选 ML。原始 counts 不自动冒充标定震级。区域曲线适用性与强震 ML 饱和需要复核。
- **历史监测**：人工输入 UTC 发震时间和位置，加入监测清单，下载历史波形、重新检测与人工复核。
- **地震目录**：按来源和复核状态筛选，分页，导出 CSV / QuakeML；QuakeML 深度明确从 km 转换为 m。
- **活动性分析**：每日事件数、震级分布、质量统计、数据完整性限制。点击“开始本地分析”调用本地小模型，右侧以 Markdown 展示报告与生成状态；公开固定报告共享五分钟缓存，管理员可自定义问题或选择在线接口。小模型只接收统计摘要，不接收原始波形或台站坐标。
- **审计**：人工事件/震相修改保留原值与理由，用版本号防止覆盖其他操作者的修改。

## 实时采集

```bash
# 自动处理已订阅台站；4 个有界下载线程
.venv/bin/python -m backend.collector --mode fdsn

# SeedLink：自动协商 v4，旧服务回退 ObsPy v3
.venv/bin/python -m backend.collector --mode seedlink --server geofon.gfz.de:18000

# 区域自动编目：按 5°×5° 分区、每批最多32台、至少3台
.venv/bin/python -m backend.collector --mode fdsn --auto-catalog --window 300 --interval 300 --vp 6.2 --vs 3.5
```

SeedLink v4 支持 miniSEED 2/3 数据负载；miniSEED 3 使用 EarthScope pymseed 解码，同时保留原包和算法可读的 miniSEED 2。每台独立持久化序号，断线退避，最大 4 MB 数据包，5 分钟分文件，限制磁盘容量。仅在波形写入后更新游标。v3 路径有有界内存队列与丢包计数，需通过 FDSN 补齐溢出/断线数据。公共服务的覆盖、延迟和可用性没有保证。

`--auto-catalog` 用于 FDSN 分批模式；NPU 部署另运行 `python -m backend.edge.realtime`，自动消费 SeedLink 归档，按重叠区域持续关联定位。普通 CPU 部署可通过工作台或 FDSN 分批任务触发编目。不要在大台网直接用默认分区作为生产科学参数，边界事件可能漏检，生产需重叠分片和区域化参数。

## 小模型

`.env` 配置：

```dotenv
SEISMICX_LLM_BASE_URL=http://127.0.0.1:11434/v1
SEISMICX_LLM_MODEL=gemma3:4b
SEISMICX_LLM_API_KEY=
SEISMICX_LLM_CONTEXT_TOKENS=7900
SEISMICX_LLM_OUTPUT_TOKENS=1400
```

仅发送统计摘要与用户问题，以 UTF-8 字节计数加封装余量作为保守输入上限，输入上限 + 最大输出严格小于 8000。服务端再次限制预算；密钥不编入前端。缺少模型服务时返回明确错误，纯统计分析仍可使用。模型输出为辅助解释，需要核查，尤其不能从缺失覆盖推断活动性变化或预测地震。

Docker 中访问宿主机 Ollama 时，macOS 使用 `http://host.docker.internal:11434/v1`，不要使用容器自己的 `127.0.0.1`。

## 算法来源与可追溯性

使用用户指定 [seismicx-skills](https://github.com/cangyeone/seismicx-skills) 的 catalog 路由，实际调用 [seismicx-catalog-skill](https://github.com/cangyeone/seismicx-catalog-skill)，固定版本：

`eebb87878ae27fbc8e33214c38c44fdeff9ba07b`

PNSN v3：100 Hz，E/N/Z，Pg/Sg/Pn/Sn，SHA-256：

`900dbf785d39b16fcaab5f53d04adddf6796b47f7aec17929abc6e7cfa5b2ddb`

技能单独安装于忽略的 `external/`，保留上游 GPL-3.0 许可。运行产物在 `runtime/runs/<job-id>/`，包含输入 miniSEED、station/velocity CSV、扫描、拾取、关联分配、定位、模型校验信息、实际命令和日志，不提交 Git。原始数据不覆盖。

网格定位是均匀速度区域基线，尚未配置区域 3D 走时表、NonLinLoc 或 SeismicX-Location checkpoint。不能把当前全球展示解读为经过验证的全球统一定位系统。

## 稳定性与部署边界

API、采集与算法 worker 为独立进程；SQLite WAL 只保存元数据和任务，原始波形存文件，前端用保峰值 min/max 包络。下载并发、时间窗、任务队列、内存包大小和缓存容量都有上限。重启时未完成的任务标记失败，保留现场供重试。

单机先用 SQLite，避免在没有吞吐基准时引入 Kafka。海量部署需改为按台网/区域分片的采集服务、Kafka/Redis Streams、PostgreSQL、对象存储与多 worker；本版本**未经过万台级吞吐或长时间容灾验收**。见 [架构和运维](docs/architecture.md)。

```bash
cp .env.example .env
docker compose up --build -d
```

默认仅监听宿主机回环地址。公开首页、台站、目录、波形及演播无需口令；后台 `/admin` 使用独立用户名和密码，部署时执行 `.venv/bin/python scripts/admin_account.py` 初始化（Docker 可用 `docker compose exec api python scripts/admin_account.py`）。配置、任务明细及所有目录修改均由服务端校验管理员会话。原 `SEISMICX_API_TOKEN` 不再授予任何权限。公网部署须使用 HTTPS。`runtime/` 需要备份；不要直接将正在写入的 SQLite 文件拷贝为备份，应使用 SQLite backup API。

## 后台与移动端

后台可调整 P/S 震相置信度、REAL 关联门槛及搜索网格、定位速度/深度/网格、连续 NPU 推理周期和台站上限、本地与在线模型接口，并修改后台账号。参数保存到数据库，下一轮生效，任务保留配置快照；模型密钥不回传浏览器。页面适应手机和桌面，手机横屏演播自动切换波形、地震列表、AI、区域地质和科普卡片，竖屏支持滚动查看。详见 [后台管理说明](docs/administration.md)。

## 验证

```bash
.venv/bin/python -m pytest tests -q
npm run build
npm audit
# 有限真实数据测试，下载南加州6台3分钟波形；不自动改为已复核
.venv/bin/python scripts/real_smoke.py
```

真实测试方法和结果见 [验证记录](docs/validation.md)。CI 使用隔离临时数据库，不依赖外网波形或本地 LLM。

底图为 Natural Earth 数据（public domain），通过原项目所用 GeoJSON 源缓存于 `public/world.geojson`。设计基准见 `docs/design/monitoring-concept.png`，界面不使用该概念图中的演示数值。

## 地震演播与直播

首页地图支持固定显示和全屏动画演播：全球 / 中国地震台网速报插播、近期地震自动轮播、真实震中距—时间波形、本地 Qwen 解读、带来源的区域地质与科普。直播窗口可用 `/?view=broadcast`，并由 OBS 采集。参数、数据含义和部署方法见 [演播说明](docs/broadcast.md)。

演播地图提供精细三维、简洁地球和平面地图，默认轻量地球。浏览器与服务器持久缓存地图；五张独立卡片默认显示，可在电脑上拖动、改变宽高、锁定或恢复布局，并在设置中分别隐藏。科普按事件轮换 12 个主题，由后台选定的本地小模型或在线大模型结合事件生成。地震列表每 3 秒更新，新速报在动画播放时优先插入；其他事件以点显示，台站点位可在演播设置开关。详见 [地图、缓存与卡片操作](docs/3d-map.md)。
