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
    time: true,
    // 内存泄漏监控
    max_memory_restart: '2G',
    // 重启策略
    min_uptime: '10s',
    max_restarts: 10,
    // 日志轮转
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    combine_logs: true
  }]
};