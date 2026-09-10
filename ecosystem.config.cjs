// PM2, fork mode, one instance. Only ONE process may hold the WhatsApp link.
module.exports = {
  apps: [
    {
      name: 'tapis',
      cwd: __dirname + '/backend',
      script: 'dist/server.js',
      node_args: '--env-file-if-exists=.env',
      instances: 1,
      exec_mode: 'fork',
      wait_ready: true,
      kill_timeout: 8000,
      env: { NODE_ENV: 'production' },
    },
  ],
}
