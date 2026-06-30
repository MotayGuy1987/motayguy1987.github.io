import supabase from './db-client.js';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('stream_reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'POST') {
      const { stream_url, match_title, issue, source } = req.body;
      if (!stream_url || !issue) {
        return res.status(400).json({ error: 'Missing stream_url or issue' });
      }
      const { data, error } = await supabase
        .from('stream_reports')
        .insert({
          stream_url,
          match_title: match_title || '',
          issue,
          source: source || '',
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Reports API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
