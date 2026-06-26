// Netlify serverless function — QMS20 data sync bridge
// GET  /api/data        → returns all qams_data rows [{bucket, data}]
// POST /api/data        → upserts {bucket, data} into qams_data

const SUPABASE_URL = 'https://bauiffaqfboqlqnmxffc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhdWlmZmFxZmJvcWxxbm14ZmZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMjc5ODAsImV4cCI6MjA5NjgwMzk4MH0.jG2VkYTt5xkej4xYiQwEroYGVhQ6P48JrzTvekuHe1M';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (event.httpMethod === 'GET') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/qams_data?select=bucket,data`,
        { headers: sbHeaders }
      );
      if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
      const rows = await res.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rows) };
    }

    if (event.httpMethod === 'POST') {
      const { bucket, data } = JSON.parse(event.body || '{}');
      if (!bucket) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing bucket' }) };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/qams_data`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ bucket, data, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase POST failed: ${res.status} ${err}`);
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    console.error('[api-data]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
