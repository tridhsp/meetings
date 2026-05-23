// Middleware: automatically rewrite Supabase URL in *-credentials responses
// Uses Origin header so the proxy URL matches the user's actual site (avoids CORS)
module.exports = function(app) {
  const SUPABASE_URL = process.env.SUPABASE_URL;

  app.use((req, res, next) => {
    if (req.path.includes('credential')) {
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (body && body.SUPABASE_URL && body.SUPABASE_URL === SUPABASE_URL) {
          const origin = req.headers.origin;
          if (origin && origin.includes('.tansinh.info')) {
            body.SUPABASE_URL = origin + '/api/sb-proxy';
          } else {
            body.SUPABASE_URL = 'https://' + req.headers.host + '/api/sb-proxy';
          }
        }
        return originalJson(body);
      };
    }
    next();
  });
};
