import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('web Dockerfile runtime user', () => {
  it('runs as non-root while only the Next cache is writable', () => {
    const dockerfile = readRepoFile('apps/web/Dockerfile');

    expect(dockerfile).toContain('USER app:app');
    expect(dockerfile).toContain('/app/apps/web/.next/cache');
    expect(dockerfile).not.toMatch(/chown\s+-R\s+app:app\s+\/app\s*(?:\\?\n|$)/);
  });
});

// The web image must be DOMAIN-AGNOSTIC — no baked API domain, so one image
// promotes dev -> prod with no rebuild.
describe('web image is domain-agnostic', () => {
  it('does not hard-require a NEXT_PUBLIC_API_URL build-arg (no failing guard)', () => {
    const dockerfile = readRepoFile('apps/web/Dockerfile');

    // The old guard `test -n "$NEXT_PUBLIC_API_URL" || … exit 1` is gone: a build
    // with no arg must succeed and yield a same-origin (domain-agnostic) image.
    expect(dockerfile).not.toMatch(/test\s+-n\s+"\$NEXT_PUBLIC_API_URL"/);
    expect(dockerfile).not.toMatch(/exit\s+1/);
  });

  it('bakes no concrete API domain into the deploy manifest', () => {
    const deploy = readRepoFile('.deckhand/deploy.yml');

    // The web build must carry no NEXT_PUBLIC_API_URL build-arg pinning a domain.
    expect(deploy).not.toMatch(/NEXT_PUBLIC_API_URL:\s*['"]?https?:\/\//);
  });
});
