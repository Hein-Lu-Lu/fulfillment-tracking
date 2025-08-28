// app/api/order-lookup/route.ts
import { NextResponse } from 'next/server';


const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN!;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const SHOP = process.env.SHOPIFY_SHOP!; // lock to your shop; do NOT read from client
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const RECAPTCHA_SEC = process.env.RECAPTCHA_SECRET || '';
const MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || '0.5');


// ——— Optional: Upstash rate limit ———
// pnpm add @upstash/ratelimit @upstash/redis
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
const useRateLimit = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
const ratelimit = useRateLimit
? new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(30, '1 m') })
: null;


function setCORS(origin?: string) {
const headers: Record<string, string> = {
'Vary': 'Origin',
'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
};
if (origin && ALLOWED.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
return headers;
}


async function verifyRecaptcha(token?: string, ip?: string) {
if (!RECAPTCHA_SEC) return true; // disabled
if (!token) return false;
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
return s.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, m => m.toUpperCase());
}


export async function OPTIONS(req: Request) {
const origin = req.headers.get('origin') || '';
return new NextResponse(null, { status: 204, headers: setCORS(origin) });
}


export async function GET(req: Request) {
const origin = req.headers.get('origin') || '';
const cors = setCORS(origin);


try {
// 1) Only allow calls from your storefront origins
if (!ALLOWED.includes(origin)) {
return NextResponse.json({ error: 'Origin not allowed' }, { status: 403, headers: cors });
}


// 2) Optional: rate limit per IP
if (ratelimit) {
const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '127.0.0.1';
const { success } = await ratelimit.limit(`orderlookup:${ip}`);
if (!success) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: cors });
}


// 3) Parse inputs
const { searchParams } = new URL(req.url);
const orderRaw = (searchParams.get('order') || '').trim();
const emailRaw = (searchParams.get('email') || '').trim().toLowerCase();
const captcha = (searchParams.get('captchaToken') || '').trim();


if (!orderRaw || !emailRaw) {
return NextResponse.json({ error: 'Missing order or email' }, { status: 400, headers: cors });
}
