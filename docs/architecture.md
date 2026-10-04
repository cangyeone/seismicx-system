# 架构与运维边界

```text
FDSN / SeedLink ── collector ── immutable miniSEED / 5-minute chunks
                       │                   │
                       └── station heartbeat + waveform index
                                           │
Browser ── FastAPI ── SQLite WAL queue ── separate worker
                          │                 └── pinned catalog skill subprocess
                          │                      scan/pick/REAL/grid/ML
                          └── events + picks + audit + provenance
Browser ── bounded aggregate statistics ── optional local/compatible LLM
```

## 数据契约

UTC ISO8601 带时区；WGS84；经纬度分别存储；深度向下为正，单位 km；采样数据保持 counts，模型按技能合同重采样至100Hz，连续拾取不做带通。台站 ID 为 `NET.STA.LOC`，波形原始 trace ID 保留完整 `NET.STA.LOC.CHA`；空位置码必须保留。仪器响应按历史事件时段请求。

台站清单同步不会改变订阅、通道或人工配置。历史波形读取不更新在线心跳。在线定义为订阅且最新收到的采样时间距离当前小于180秒，失去连接后采样自然过期。外部目录更新不能覆盖任何已人工修改的事件。

## 运行隔离

一个 SQLite 数据目录只允许一个 worker（文件锁）。它从持久化任务表取任务，长时间算法在独立 subprocess 执行，单阶段15分钟限时。API 不等待算法完成。worker 活性心跳独立线程刷新。中断任务在 worker 重启时明确标为失败，用户可重试，不假装完成。

FDSN 请求单次时间窗≤30分钟、每批≤32台、下载线程4、HTTP超时45秒。UI 数据最大1000事件/页，波形每通道约1200个min/max桶。科学数据保存在原始精度，包络只用于显示。

SeedLink4 上限4MB/packet，同步归档以TCP背压限制内存；游标按服务器+台站持久化，落盘后才推进。短暂断线可请求下一序号，服务端如果已淘汰旧数据仍可能有缺口，需用FDSN追补。服务端给出的格式/协议不支持时停止并显示错误。v3 使用 ObsPy，溢出计数可见，不声称零丢包。

缓存清理只覆盖`runtime/waveforms`且按文件年龄，科研任务的`runtime/runs`输入不自动清理。总miniSEED容量达到阈值时暂停采集，避免悄悄耗尽磁盘。任务产物需要定期人工归档。

## 科学质量门槛

自动事件全部candidate；记录RMS、方位角空缺、边界深度、速度模型与模型校验。真实强震回放验证不能替代区域泛化、漏检/误检统计。不同关联阈值必须比较，S波低置信度应人工确认。震源深度位于边界不能靠简单放宽阈值“修好”。ML需要响应成功和区域R曲线适用性，并需检查震级饱和、剪切及离群台站。

LLM只有统计解释权限，不能修改事件、震相、台站或运行参数。分析只统计数据库已收录内容，目录时间跨度不等于完整观测覆盖。模型生成的文字不能用于确定性地震预测。

## 大规模扩展

本实现没有编造吞吐量。部署前需测量台站数×通道数×采样率×保留时间，并在目标硬件进行断网、积压、重启、磁盘满演练。

超过单机预算时：采集按提供方/区域拆分；用Kafka或Redis Streams持久化接收；原始miniSEED进对象存储/SDS；PostgreSQL保存目录与任务；worker按区域和模型分片。REAL区域分片要重叠并跨分片去重。不要把共享SQLite文件放在网络文件系统上扩容。

## 安全与维护

公开只读数据与单管理员后台分离。管理员使用 scrypt 密码摘要、12 小时 HttpOnly / SameSite=Strict 会话 Cookie，HTTPS 下使用 Secure，写请求校验 CSRF 与 Origin。修改账号撤销所有会话；登录连续失败会限流。算法设置采用版本冲突检测并记录账号与配置快照；目录审计保留修改前后和理由。尚未实现多人 OIDC/RBAC；共享管理员账号不能区分实际操作者。密钥不回传前端。CSV字符串做公式注入转义。算法命令固定为参数数组，拒绝网页提交任意shell命令。

备份使用SQLite backup API加原始波形/运行目录备份；保留技能固定版本与依赖锁。容器以非root用户运行。生产入口需TLS与访问控制。
