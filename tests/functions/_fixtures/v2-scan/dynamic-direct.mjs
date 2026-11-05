// POSITIVE: Blobs reached by dynamic import() only.
export default async () => {
  const { getStore } = await import('@netlify/blobs');
  return new Response(String(typeof getStore));
};
