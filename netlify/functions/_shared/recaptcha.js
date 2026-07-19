'use strict';

async function verifyRecaptcha(token, { fetchImpl = fetch, secret = process.env.RECAPTCHA_SECRET_KEY } = {}) {
  if (!secret) throw new Error('recaptcha: missing RECAPTCHA_SECRET_KEY');
  if (!token) return false;
  const params = new URLSearchParams({ secret, response: token });
  const res = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return false;
  const json = await res.json();
  return !!json.success;
}

module.exports = { verifyRecaptcha };
