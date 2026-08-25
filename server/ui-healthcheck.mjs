const base = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const page = await fetch(`${base}/archive`, { signal: AbortSignal.timeout(5_000) });
if (!page.ok) process.exit(1);

const html = await page.text();
const assetPath = html.match(/(?:href|src)="(\/assets\/[^"]+)"/)?.[1];
if (!assetPath) process.exit(1);

const asset = await fetch(`${base}${assetPath}`, { signal: AbortSignal.timeout(5_000) });
process.exit(asset.ok ? 0 : 1);
