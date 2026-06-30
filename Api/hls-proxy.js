// This route has been removed from AansStreams.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(404).json({ error: 'HLS proxy feature has been removed.' });
}
