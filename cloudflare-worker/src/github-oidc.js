import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`), { timeoutDuration: 5000, cooldownDuration: 30000 });

export async function verifyContextJob(request, env, keySet = JWKS) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length > 16384) return null;
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = env.TELEGRAM_CONTEXT_REPOSITORY_ID;
  const audience = env.TELEGRAM_CONTEXT_OIDC_AUDIENCE;
  if (!repository || !repositoryId || !audience) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), keySet, {
      issuer: ISSUER, audience, algorithms: ['RS256'], clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'nbf', 'jti', 'repository_id', 'ref', 'workflow_ref', 'run_id', 'run_attempt'],
      maxTokenAge: '10m',
    });
    if (payload.repository !== repository || payload.repository_id !== String(repositoryId) || payload.ref !== 'refs/heads/main' ||
        payload.workflow_ref !== `${repository}/.github/workflows/telegram-context-sync.yml@refs/heads/main` ||
        !['schedule', 'workflow_dispatch'].includes(payload.event_name) || !/^\d+$/.test(payload.run_id) || !/^\d+$/.test(payload.run_attempt) ||
        payload.exp - payload.iat > 900) return null;
    return { run: `${payload.run_id}:${payload.run_attempt}` };
  } catch { return null; }
}
