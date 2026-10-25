/**
 * Serves the built frontend (dist/) with deliberate HTTP caching:
 *
 *   /assets/*            hashed file names -> cache for a year, `immutable`
 *   index.html, sw.js    -> `no-cache` (always revalidate, ETag makes it a cheap 304)
 *   icons, manifest      -> one day
 *
 * Text files are compressed with Brotli (or gzip) once and kept in memory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);

interface CachedFile {
  body: Buffer;
  etag: string;
  type: string;
  br?: Buffer;
  gzip?: Buffer;
}

export function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath === '/' || urlPath.endsWith('.html') || urlPath === '/sw.js') return 'no-cache';
  if (urlPath.endsWith('.webmanifest')) return 'public, max-age=3600';
  return 'public, max-age=86400';
}

export function securityHeaders(host: string | undefined): Record<string, string> {
  const wsHosts = host ? ` ws://${host} wss://${host}` : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self'${wsHosts}`,
      "manifest-src 'self'",
      "worker-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  };
}

export function createStaticHandler(distDir: string) {
  const root = resolve(distDir);
  const cache = new Map<string, CachedFile>();
  const available = existsSync(join(root, 'index.html'));

  function load(filePath: string): CachedFile | null {
    const hit = cache.get(filePath);
    if (hit) return hit;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
    const body = readFileSync(filePath);
    const file: CachedFile = {
      body,
      etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
      type: TYPES[extname(filePath)] ?? 'application/octet-stream',
    };
    cache.set(filePath, file);
    return file;
  }

  function compressed(file: CachedFile, ext: string, acceptEncoding: string): { body: Buffer; encoding?: string } {
    if (!COMPRESSIBLE.has(ext) || file.body.length < 1024) return { body: file.body };
    if (/\bbr\b/.test(acceptEncoding)) {
      file.br ??= brotliCompressSync(file.body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      });
      return { body: file.br, encoding: 'br' };
    }
    if (/\bgzip\b/.test(acceptEncoding)) {
      file.gzip ??= gzipSync(file.body, { level: 9 });
      return { body: file.gzip, encoding: 'gzip' };
    }
    return { body: file.body };
  }

  /** Returns true if it handled the request. */
  return function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
    if (!available) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    // Block "../" tricks: the resolved path must stay inside dist/.
    const candidate = resolve(root, '.' + normalize(decoded));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.writeHead(403).end();
      return true;
    }

    let servedPath = urlPath;
    let file = decoded === '/' ? null : load(candidate);
    if (!file) {
      // Unknown file with an extension = real 404. Anything else is an app route.
      if (extname(decoded) !== '') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }).end('Not found');
        return true;
      }
      file = load(join(root, 'index.html'));
      servedPath = '/index.html';
      if (!file) return false;
    }

    const headers: Record<string, string> = {
      'Content-Type': file.type,
      'Cache-Control': cacheControlFor(servedPath),
      ETag: file.etag,
      Vary: 'Accept-Encoding',
    };
    if (servedPath === '/index.html') Object.assign(headers, securityHeaders(req.headers.host));
    if (servedPath === '/sw.js') headers['Service-Worker-Allowed'] = '/';

    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers).end();
      return true;
    }

    const ext = extname(servedPath === '/index.html' ? 'index.html' : decoded);
    const { body, encoding } = compressed(file, ext, String(req.headers['accept-encoding'] ?? ''));
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
