// /api/order-lookup.ts (Next.js "pages" API route) — Node runtime
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';

const API_SECRET   = process.env.SHOPIFY_API_SECRET || '';       // App's API secret (from Partner Dashboard)
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN; // Single-shop token (or fetch per-shop token in prod)
const API_VERSION  = process.env.SHOPIFY_API_VERSION || '2025-07';
const ALLOWED_SHOP = process.env.SHOPIFY_SHOP;                   // Optional hardening: your-shop.myshopify.com

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Verify App Proxy signature per Shopify docs (HMAC-SHA256 over sorted "key=value" with arrays joined by commas)
function verifyProxySignature(req: NextApiRequest): boolean {
  const url = new URL(req.url || '', `https://${req.headers.host}`);
  const params = url.searchParams;

  const provided = params.get('signature') || '';
  if (!provided || !API_SECRET) return false;

  // Build a multimap of all params except signature
  const map = new Map<string, string[]>();
  for (const [k, v] of params) {
    if (k === 'signature') continue;
    const arr = map.get(k) || [];
    arr.push(v);
    map.set(k, arr);
  }

  // Sort keys, join values with ',', then concatenate all pairs without '&'
  const message = Array.from(map.keys())
    .sort()
    .map((k) => `${k}=${map.get(k)!.join(',')}`)
    .join('');

  const digest = crypto.createHmac('sha256', API_SECRET).update(message).digest('hex');
  return timingSafeEqual(digest, provided);
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 1) Verify request really came through Shopify App Proxy
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const url = new URL(req.url || '', `https://${req.headers.host}`);
    const shop = url.searchParams.get('shop') || ''; // e.g. my-store.myshopify.com
    const orderRaw = (url.searchParams.get('order') || '').trim();
    const emailRaw = (url.searchParams.get('email') || '').trim().toLowerCase();

    if (!orderRaw || !emailRaw) {
      return res.status(400).json({ error: 'Missing order or email' });
    }
    if (ALLOWED_SHOP && shop !== ALLOWED_SHOP) {
      return res.status(403).json({ error: 'Shop not allowed' });
    }

    // If you use per-shop OAuth, look up the token by "shop" here instead of using ADMIN_TOKEN
    if (!ADMIN_TOKEN) {
      return res.status(500).json({ error: 'Missing ADMIN API token on server' });
    }

    const orderName = orderRaw.replace(/^#/, '');
    // Escape single quotes for the search syntax
    const esc = (s: string) => s.replace(/'/g, "\\'");
    const q = `email:'${esc(emailRaw)}' AND name:'${esc(orderName)}'`;

    const endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
    const gql = `
      query ($q: String!) {
        orders(first: 1, query: $q) {
          edges {
            node {
              name
              displayFulfillmentStatus
              statusPageUrl
              fulfillments(first: 10) { trackingInfo { number url company } }
            }
          }
        }
      }`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ADMIN_TOKEN,
      },
      body: JSON.stringify({ query: gql, variables: { q } }),
    });

    const data = await resp.json();
    const node = data?.data?.orders?.edges?.[0]?.node;
    if (!node) return res.status(200).json({ found: false });

    return res.status(200).json({
      found: true,
      orderName: node.name,
      displayStatus: titleCase(node.displayFulfillmentStatus || 'UNKNOWN'),
      statusPageUrl: node.statusPageUrl || null,
      tracking: (node.fulfillments || []).flatMap((f: any) => f.trackingInfo || []),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}
