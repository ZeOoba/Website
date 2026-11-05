// POSITIVE: a relative dynamic import() is a reachable edge.
export default async () => {
  const mod = await import('./_shared/esm-store.mjs');
  return new Response(String(typeof mod.getStore));
};
