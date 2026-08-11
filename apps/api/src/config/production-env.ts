const REQUIRED_PRODUCTION_SECRETS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'CARD_ENCRYPTION_KEY',
  'CARD_HMAC_KEY',
  'PIN_ENCRYPTION_KEY',
] as const;

export function assertProductionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;

  const missing = REQUIRED_PRODUCTION_SECRETS.filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length) {
    throw new Error(
      `Configuration de production incomplète : ${missing.join(', ')}`,
    );
  }

  if ((env.JWT_ACCESS_SECRET?.trim().length ?? 0) < 32) {
    throw new Error(
      'JWT_ACCESS_SECRET doit contenir au moins 32 caractères en production',
    );
  }
}
