// Installs pm2-windows-service non-interactively. Its own pm2-service-install
// CLI always runs an inquirer "environment setup" prompt; setup-agent.ps1 sets
// PM2_HOME / PM2_SERVICE_PM2_DIR itself, so call install() with no_setup=true.
//
// Usage: node install-pm2-service.js <path to global pm2-windows-service>

const pm2ws = require(process.argv[2])

pm2ws.install('PM2', true).then(
  () => console.log('PM2 service installed and started.'),
  (err) => {
    console.error('PM2 service install failed:', err)
    process.exit(1)
  }
)
