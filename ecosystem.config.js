module.exports = {
  apps: [
    {
      name: 'printer-agent',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 9999,
      min_uptime: '10s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
    },
  ],
}
