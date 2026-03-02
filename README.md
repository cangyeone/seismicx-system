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
- **数据库持久化**：集成 SQLite 数据库，自动存储历史地震和台站数据
- **实时动画效果**：新地震事件触发炫酷的爆炸动画和地图居中效果
- **WebSocket实时通信**：双向实时数据流，支持即时更新和通知
- **智能主题切换**：支持深色/浅色主题无缝切换，自动保存用户偏好

## 🛠️ 技术栈

- **前端框架**: React 19
- **构建工具**: Vite 6
- **AI 推理**: ONNX Runtime (Node.js)
- **数据可视化**: D3.js (地图渲染), Canvas API (高性能波形渲染)
- **样式处理**: Tailwind CSS 4
- **动画效果**: Motion (Framer Motion)
- **后端服务**: Express + WebSocket (用于实时数据流与 AI 推理)
- **数据库**: SQLite (Better-SQLite3) 用于数据持久化
- **实时通信**: WebSocket 双向数据流
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
│   ├── components/          # UI 组件 (地图、PNSN 波形显示、列表等)
│   │   ├── AnimatedSeismicMap.tsx  # 带动画的新版地图组件
│   │   ├── SeismicMap.tsx          # 原始地图组件
│   │   └── WaveformDisplay.tsx     # 波形显示组件
│   ├── hooks/               # React 自定义 Hooks
│   │   └── useWebSocket.ts         # WebSocket 连接管理
│   ├── database/            # 数据库相关
│   │   ├── init.ts                 # 数据库初始化
│   │   ├── earthquakeDAO.ts        # 地震数据访问对象
│   │   └── stationDAO.ts           # 台站数据访问对象
│   ├── services/            # 数据服务 (USGS API 交互)
│   ├── App.tsx              # 主应用入口
│   └── index.css            # 全局样式
├── pnsn_repo/               # PNSN 模型资源库
├── server.ts                # Express + ONNX 推理后端 + WebSocket 服务
├── ecosystem.config.js      # PM2 部署配置
├── seismic_data.db          # SQLite 数据库文件
├── package.json             # 项目依赖与脚本
└── vite.config.ts           # Vite 配置文件
```

## 🚀 快速开始

### 环境要求
- Node.js >= 18.0.0
- npm >= 8.0.0

### 安装依赖
```bash
npm install
```

### 启动开发服务器
```bash
npm run dev
```

服务器将启动在 `http://localhost:3000`

### 构建生产版本
```bash
npm run build
```

### 预览生产构建
```bash
npm run preview
```

### 代码检查
```bash
npm run lint
```

## 🏭 生产环境部署

### 构建生产版本
```bash
npm run build
```

### 生产环境启动
```bash
NODE_ENV=production npm run preview
```

### 使用PM2进行进程管理（推荐）
```bash
# 安装PM2
npm install -g pm2

# 启动应用
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 日志查看
pm2 logs seismicx-system

# 重启应用
pm2 restart seismicx-system

# 停止应用
pm2 stop seismicx-system
```

### PM2配置文件 (ecosystem.config.js)
```javascript
module.exports = {
  apps: [{
    name: 'seismicx-system',
    script: './server.ts',
    interpreter: './node_modules/.bin/tsx',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
```

### Docker部署（可选）
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "preview"]
```

### 系统服务配置（Linux systemd）
创建 `/etc/systemd/system/seismicx.service`：
```ini
[Unit]
Description=SeismicX Earthquake Monitoring System
After=network.target

[Service]
Type=simple
User=seismic
WorkingDirectory=/path/to/seismicx-system
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run preview
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用服务：
```bash
sudo systemctl enable seismicx.service
sudo systemctl start seismicx.service
```

## 📊 监控与维护

### 性能监控
```bash
# PM2内置监控面板
pm2 monit

# 查看应用状态详情
pm2 show seismicx-system

# 内存和CPU使用情况
pm2 list
```

### 健康检查端点
应用提供了健康检查API：
```
GET /api/health
响应: {"status": "ok"}
```

### 日志管理
```bash
# 实时查看日志
pm2 logs seismicx-system --lines 100

# 清理旧日志
pm2 flush

# 日志备份
cp logs/*.log /backup/logs/
```

### 自动备份策略
建议设置定时任务备份重要数据：
```bash
# 添加到 crontab
0 2 * * * cd /path/to/seismicx-system && pm2 save
0 3 * * * tar -czf /backup/seismicx-$(date +\%Y\%m\%d).tar.gz logs/ && rm -rf logs/*
```

### 安全加固建议
1. **防火墙配置**：
```bash
ufw allow 3000/tcp
ufw enable
```

2. **反向代理**（推荐使用Nginx）：
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

3. **SSL证书**（使用Let's Encrypt）：
```bash
certbot --nginx -d your-domain.com
```

## 🔧 开发配置

### 端口配置
默认端口为 `3000`，如需更改可在 `server.ts` 中修改：
```javascript
const PORT = 3000; // 修改为你需要的端口号
```

### 模型配置
系统会自动尝试加载以下模型（按优先级排序）：
1. `./pnsn_repo/pickers/china.rnn.pnsn.onnx`
2. `./pnsn_repo/pickers/rnn.onnx` 
3. `./pnsn_repo/pickers/pnsn.v1.onnx`

如果所有模型都加载失败，系统将运行在模拟模式下，仍然可以查看完整的UI界面。

### 环境变量
创建 `.env` 文件来自定义配置：
```env
NODE_ENV=development
PORT=3000
```

## 📝 开发说明

- **数据源**: 地震事件通过 USGS 实时 GeoJSON API 获取。
- **波形模拟**: 后端通过 WebSocket 模拟 100Hz 的三分量地震数据流，并实时喂入 PNSN 模型。
- **推理性能**: 在 Node.js 环境下，单次 102.4s 窗口推理耗时通常小于 50ms。
- **故障恢复**: 当模型加载失败时，系统自动切换到模拟模式，确保UI功能完整可用。

## 🐛 常见问题

### 端口被占用
如果遇到 `EADDRINUSE` 错误，可以：
1. 查看占用端口的进程：`lsof -i :3000`
2. 终止进程：`kill -9 [PID]`
3. 或者修改端口号后重启

### 模型加载失败
这是正常现象，系统会自动切换到模拟模式运行。所有UI功能仍然可用，只是缺少真实的AI拾取功能。

### 依赖安装问题
如果 `npm install` 失败，可以尝试：
```bash
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

---
由 yuziye@cea-igp.ac.cn 开发完成。
