import { TransactionsService } from './transactions.service';

describe('TransactionsService import identity', () => {
  const service = new TransactionsService({} as never);
  const fingerprint = (row: Record<string, unknown>) =>
    (service as unknown as { transactionFingerprint(value: Record<string, unknown>, card: string): string })
      .transactionFingerprint(row, '790351');

  const transaction = {
    date: '2026-08-11T08:42:17.000Z',
    cardNumber: '790351',
    vehicle: '7992 TU 166',
    beneficiary: 'Seifeddine Said',
    station: 'TOTAL FOUCHANA',
    product: 'GASOIL SS',
    liters: 20,
    amount: 44.1,
    authorizationCode: 'AUTH-42',
  };

  it('produit la même empreinte quel que soit le fichier ou la ligne source', () => {
    expect(fingerprint(transaction)).toBe(fingerprint({ ...transaction }));
  });

  it('distingue deux opérations effectuées à des heures différentes', () => {
    expect(fingerprint(transaction)).not.toBe(fingerprint({ ...transaction, date: '2026-08-11T08:43:17.000Z' }));
  });

  it('distingue deux autorisations Total différentes', () => {
    expect(fingerprint(transaction)).not.toBe(fingerprint({ ...transaction, authorizationCode: 'AUTH-43' }));
  });
});
