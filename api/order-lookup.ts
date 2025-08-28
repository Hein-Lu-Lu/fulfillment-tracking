// Next.js "pages" API route
import type { NextApiRequest, NextApiResponse } from 'next';

const ADMIN_TOKEN   = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
const API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-07';
const SHOP          = process.env.SHOPIFY_SHOP!;  // lock to your shop; don't read from the client
const ALLOWED       = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()); // e.g. https://your-store.myshopify.com,https://yourdomain.com
const RECAPTCHA_SEC = process.env.RECAPTCHA_SECRET || '';
const MIN_SCORE     = Number(process.env.RECAPTCHA_MIN_SCORE || '0.5');

function setCORS(res: NextApiResponse, origin?: string) {
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

async function verifyRecaptcha(token: string, ip?: string) {
  if (!RECAPTCHA_SEC) return true; // disabled
  const body = new URLSearchParams({ secret: RECAPTCHA_SEC, response: token });
  if (ip) body.set('remoteip', ip);
  const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const j = await r.json();
  if (!j.success) return false;
  if (typeof j.score === 'number' && j.score < MIN_SCORE) return false;
  return true;
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').toLowerCase().replace(/(^|\\s)\\S/g, m => m.toUpperCase());
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const origin = (req.headers.origin as string) || '';
  setCORS(res, origin);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // Only allow calls from your storefront origins
    if (!ALLOWED.includes(origin)) return res.status(403).json({ error: 'Origin not allowed' });

    const url = new URL(req.url || '', `https://${req.headers.host}`);
    const orderRaw = (url.searchParams.get('order') || '').trim();
    const emailRaw = (url.searchParams.get('email') || '').trim().toLowerCase();
    const captcha  = (url.searchParams.get('captchaToken') || '').trim(); // send this from the theme

    if (!orderRaw || !emailRaw) return res.status(400).json({ error: 'Missing order or email' });
    if (!ADMIN_TOKEN || !SHOP)   return res.status(500).json({ error: 'Server not configured' });

    // Optional: CAPTCHA
    const ok = await verifyRecaptcha(captcha, req.headers['x-forwarded-for'] as string);
    if (!ok) return res.status(400).json({ error: 'Captcha failed' });

    const orderName = orderRaw.replace(/^#/, '');
    const esc = (s: string) => s.replace(/'/g, "\\'");
    const q = `email:'${esc(emailRaw)}' AND name:'${esc(orderName)}'`;

    const endpoint = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
    const gql = `
      query ($q: String!) {
        orders(first: 1, query: $q) {
          edges { node {
            name
            displayFulfillmentStatus
            statusPageUrl
            fulfillments(first: 10) { trackingInfo { number url company } }
          } }
        }
      }`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ADMIN_TOKEN
      },
      body: JSON.stringify({ query: gql, variables: { q } })
    });

    const data = await resp.json();
    const node = data?.data?.orders?.edges?.[0]?.node;
    if (!node) return res.status(200).json({ found: false });

    return res.status(200).json({
      found: true,
      orderName: node.name,
      displayStatus: titleCase(node.displayFulfillmentStatus || 'UNKNOWN'),
      statusPageUrl: node.statusPageUrl || null,
      tracking: (node.fulfillments || []).flatMap((f: any) => f.trackingInfo || [])
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}


