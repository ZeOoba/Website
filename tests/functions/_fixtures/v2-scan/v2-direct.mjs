// POSITIVE, and satisfies the V2 contract: default export, no `handler`.
import { getStore } from '@netlify/blobs';
export default async () => new Response(String(typeof getStore));
