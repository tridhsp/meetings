module.exports = function(app) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const cache = require('./_cache-helper');
  // Cache config: only these GET query patterns are cached
  const CACHEABLE = [
    { match: 'quizzes', ttl: 300 },
    { match: 'books_chapters', ttl: 3600 },
  ];
  function getCacheKey(url, acceptHeader) {
    for (const rule of CACHEABLE) {
      if (url.includes(rule.match)) {
        const suffix = (acceptHeader && acceptHeader.includes('pgrst.object')) ? ':single' : ':list';
        return { key: 'sbproxy:' + url + suffix, ttl: rule.ttl };
      }
    }
    return null;
  }
  app.use('/sb-proxy', async (req, res) => {
    const targetUrl = SUPABASE_URL + req.url;
    const headers = {};
    const forward = [
      'authorization', 'apikey', 'content-type', 'accept', 'prefer',
      'x-client-info', 'content-profile', 'accept-profile', 'range'
    ];
    for (const h of forward) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    // LOG: show what we're forwarding
      console.log('[sb-proxy] auth header present:', !!headers['authorization']);
      console.log('[sb-proxy] apikey present:', !!headers['apikey']);
    }
    // --- CACHE: only GET requests for cacheable patterns ---
    if (req.method === 'GET') {
      const cacheInfo = getCacheKey(req.url, req.headers['accept']);
      if (cacheInfo) {
        const cached = await cache.get(cacheInfo.key);
        if (cached) {
          }
          if (req.url.includes('quizzes')) {
            console.log('[sb-proxy] CACHE HIT for quizzes');
          }
          if (req.url.includes('books_chapters')) {
            console.log('[sb-proxy] CACHE HIT for books_chapters');
          }
          res.status(cached.status);
          for (const [h, v] of Object.entries(cached.headers)) {
            res.set(h, v);
          }
          return res.send(cached.body);
        }
      }
    }
    const options = { method: req.method, headers };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body != null && Object.keys(req.body).length > 0) {
      options.body = JSON.stringify(req.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    try {
      const response = await fetch(targetUrl, options);
      res.status(response.status);
      const respHeaders = {};
      for (const h of ['content-type', 'content-range', 'x-total-count']) {
        const val = response.headers.get(h);
        if (val) {
          res.set(h, val);
          respHeaders[h] = val;
        }
      }
      const body = await response.text();
      // LOG: show what Supabase returned
      }
      // --- CACHE: store successful GET responses ---
      if (req.method === 'GET' && response.status >= 200 && response.status < 300) {
        const cacheInfo = getCacheKey(req.url, req.headers['accept']);
        if (cacheInfo) {
          await cache.set(cacheInfo.key, {
            status: response.status,
            headers: respHeaders,
            body: body,
          }, cacheInfo.ttl);
        }
      }
      // --- CACHE: invalidate on write-through (POST/PUT/PATCH/DELETE via sb-proxy) ---
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && response.status >= 200 && response.status < 300) {
        for (const rule of CACHEABLE) {
          if (req.url.includes(rule.match)) {
            await cache.delPattern('sbproxy:*' + rule.match + '*');
            console.log('[sb-proxy] CACHE INVALIDATED for ' + rule.match + ' (write-through ' + req.method + ')');
            break;
          }
        }
      }
      res.send(body);
    } catch (err) {
      console.error('[sb-proxy] Error:', err.message);
      res.status(502).json({ error: 'Supabase proxy failed', message: err.message });
    }
  });
};
