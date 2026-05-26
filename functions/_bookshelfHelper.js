// /opt/my-api/routes/_bookshelfHelper.js
// Shared Supabase helpers for all Bookshelf routes

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(event) {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const supabase = createClient((process.env.SUPABASE_INTERNAL_URL||process.env.SUPABASE_URL), process.env.SUPABASE_ANON_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

function ok(data) {
  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(data) };
}

function err(msg, code = 400) {
  return { statusCode: code, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}

async function isSuperAdmin(userId) {
  if (!userId) return false;
  try {
    const supabase = getSupabase();
    const { data } = await supabase.from('user_roles').select('role').eq('uid', userId).single();
    return data?.role === 'Super Admin';
  } catch (e) {
    return false;
  }
}

// Express wrapper: converts req → Netlify-style event, calls handler, sends response
function wrap(routePath, handler, method) {
  method = method || 'post';
  return function(app) {
    app.options(routePath, function(req, res) {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      res.status(204).end();
    });

    app[method](routePath, async function(req, res) {
      try {
        var event = {
          httpMethod: req.method,
          headers: req.headers,
          queryStringParameters: req.query || {},
          body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
        };
        var result = await handler(event);
        if (result.headers) {
          Object.entries(result.headers).forEach(function(pair) { res.set(pair[0], pair[1]); });
        }
        res.status(result.statusCode || 200);
        try {
          res.json(JSON.parse(result.body));
        } catch(e) {
          res.send(result.body || '');
        }
      } catch (error) {
        console.error('[' + routePath + ']', error);
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  };
}

module.exports = { getSupabase, getUser, corsHeaders, ok, err, isSuperAdmin, wrap };
