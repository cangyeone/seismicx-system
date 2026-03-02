#!/bin/bash
# 一键修复台站显示问题

echo "🚀 开始一键修复台站显示问题..."

# 1. 杀死所有相关进程
echo " Terminating processes..."
pkill -f "node.*server.ts" >/dev/null 2>&1
pkill -f run_collector.py >/dev/null 2>&1
pkill -f python >/dev/null 2>&1

# 2. 等待进程结束
sleep 2

# 3. 重新启动后端服务
echo " Starting backend server..."
cd /Users/yuziye/Documents/GitHub/seismicx-system
npm run dev > /dev/null 2>&1 &
BACKEND_PID=$!

# 4. 启动Python采集器
echo " Starting Python collector..."
python run_collector.py > /dev/null 2>&1 &
COLLECTOR_PID=$!

# 5. 等待服务启动
sleep 8

# 6. 检查状态
echo " Checking system status..."
echo "Backend: $(lsof -i :3000 | wc -l) connections"
echo "Collector: $(lsof -i :8765 | wc -l) connections"

# 7. 显示完成信息
echo "✅ 修复完成！"
echo "请在浏览器中访问 http://localhost:5173"
echo "如果仍然显示 IU.UNK，请按 Ctrl+Shift+R 强制刷新页面"

# 清理
trap "kill $BACKEND_PID $COLLECTOR_PID" EXIT