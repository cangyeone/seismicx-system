<p align="left">
  <img src="logo.png" alt="SeismoX System Logo"/>
</p>

# SystemX GLOBAL - 全球地震监测与 AI 实时拾取系统

SystemX GLOBAL 是一款基于 React + Vite + D3.js 构建的高性能、沉浸式全球地震实时监测仪表盘。该系统不仅集成了 USGS (美国地质调查局) 的实时数据流，更深度集成了 **PNSN (SeismicX-PnSn)** AI 地震震相检测算法，实现了工业级的实时地震波形拾取与分析。

## 🌟 核心功能

- **AI 实时震相拾取 (PNSN)**：集成 SeismicX-PnSn 深度学习模型，实时自动识别 `Pg`, `Sg`, `Pn`, `Sn` 震相。
- **3-分量实时监控**：支持 Z (垂直)、N (北向)、E (东向) 三分量同步监测，采样率高达 **100Hz**。
- **高性能推理引擎**：后端采用 **ONNX Runtime**，实现毫秒级的滑动窗口（102.4s）实时推理。
- **实时全球地图**：基于 D3.js 的 Mercator 投影地图，实时标注全球地震事件与台站网络。
- **地震事件追踪**：自动获取 USGS 最近 1 小时的地震数据，支持震级筛选与详细信息查看。
- **沉浸式 UI 设计**：采用 Dark Mode 技术风格，针对大屏监控进行了深度优化，波形图支持动态 AI 标注。

## 🛠️ 技术栈

- **前端框架**: React 19
- **构建工具**: Vite 6
- **AI 推理**: ONNX Runtime (Node.js)
- **数据可视化**: D3.js (地图渲染), Canvas API (高性能波形渲染)
- **样式处理**: Tailwind CSS 4
- **动画效果**: Motion (Framer Motion)
- **后端服务**: Express + WebSocket (用于实时数据流与 AI 推理)
- **图标库**: Lucide React

## 🚀 拾取算法说明 (PNSN Integration)

系统集成了 [cangyeone/pnsn](https://github.com/cangyeone/pnsn) 拾取器：
- **模型版本**: `china.rnn.pnsn.onnx` (针对中国大陆优化的 RNN 模型)
- **输入窗口**: 10240 采样点 (约 102.4 秒)
- **拾取策略**: 
  - 60 秒三分量对齐逻辑。
  - 自动缺失分量补偿（支持单分量降级运行）。
  - 基于概率峰值的实时去重拾取。

## 📁 项目结构

```text
├── src/
│   ├── components/       # UI 组件 (地图、PNSN 波形显示、列表等)
│   ├── services/         # 数据服务 (USGS API 交互)
│   ├── App.tsx           # 主应用入口
│   └── index.css         # 全局样式
├── pnsn_repo/            # PNSN 模型资源库
├── server.ts             # Express + ONNX 推理后端 + WebSocket 服务
├── package.json          # 项目依赖与脚本
└── vite.config.ts        # Vite 配置文件
```

## 📝 开发说明

- **数据源**: 地震事件通过 USGS 实时 GeoJSON API 获取。
- **波形模拟**: 后端通过 WebSocket 模拟 100Hz 的三分量地震数据流，并实时喂入 PNSN 模型。
- **推理性能**: 在 Node.js 环境下，单次 102.4s 窗口推理耗时通常小于 50ms。

---
由 yuziye@cea-igp.ac.cn 开发完成。
