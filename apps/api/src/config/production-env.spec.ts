import { assertProductionEnvironment } from './production-env';

describe('assertProductionEnvironment', () => {
  it('autorise une configuration locale sans secrets', () => {
    expect(() =>
      assertProductionEnvironment({ NODE_ENV: 'test' }),
    ).not.toThrow();
  });

  it('refuse un démarrage de production incomplet', () => {
    expect(() =>
      assertProductionEnvironment({ NODE_ENV: 'production' }),
    ).toThrow(/DATABASE_URL.*JWT_ACCESS_SECRET.*CARD_ENCRYPTION_KEY/);
  });

  it('refuse un secret JWT trop court', () => {
    expect(() =>
      assertProductionEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://database',
        JWT_ACCESS_SECRET: 'trop-court',
        CARD_ENCRYPTION_KEY: 'card-encryption',
        CARD_HMAC_KEY: 'card-hmac',
        PIN_ENCRYPTION_KEY: 'pin-encryption',
      }),
    ).toThrow(/au moins 32 caractères/);
  });

  it('accepte une configuration de production complète', () => {
    expect(() =>
      assertProductionEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://database',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        CARD_ENCRYPTION_KEY: 'card-encryption',
        CARD_HMAC_KEY: 'card-hmac',
        PIN_ENCRYPTION_KEY: 'pin-encryption',
      }),
    ).not.toThrow();
  });
});
