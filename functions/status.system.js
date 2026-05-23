const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APP_DESCRIPTIONS = {
  calling: 'Phone calling app (VBot, recordings)',
  baihoc: 'Lesson/TTKB management',
  notice: 'Student notifications & alerts',
  message: 'Messaging & reminders',
  duty: 'Teacher duty reminders',
  watch: 'Room monitoring & join tracking',
  system: 'Droplet system utilities',
};

module.exports = function (app) {
  app.get('/droplet-status', (req, res) => {
    const routesDir = path.join(__dirname);
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js') && f !== 'status.system.js');
    const grouped = {};
    files.forEach(file => {
      const parts = file.replace('.js', '').split('.');
      const appName = parts[parts.length - 1] || 'unknown';
      if (!grouped[appName]) grouped[appName] = [];
      grouped[appName].push(parts.slice(0, -1).join('.'));
    });
    let cronJobs = [];
    try {
      const crontab = execSync('crontab -l 2>/dev/null').toString();
      const lines = crontab.split('\n').filter(l => l.includes('localhost:3111'));
      cronJobs = lines.map(line => {
        const scheduleMatch = line.match(/^([^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+)/);
        const routeMatch = line.match(/localhost:3111\/([^\s>]+)/);
        return { schedule: scheduleMatch ? scheduleMatch[1] : 'unknown', route: routeMatch ? routeMatch[1] : 'unknown' };
      });
    } catch (e) {}
    const apps = {};
    Object.keys(grouped).sort().forEach(appName => {
      apps[appName] = {
        description: APP_DESCRIPTIONS[appName] || 'No description - add one in status.system.js',
        routes: grouped[appName].map(route => {
          const cron = cronJobs.find(c => c.route === route);
          return { name: route, cron: cron ? cron.schedule : null };
        }),
      };
    });
    res.json({ server: 'JitsiMeet droplet', port: 3111, total_routes: files.length, total_apps: Object.keys(apps).length, apps });
  });
};
