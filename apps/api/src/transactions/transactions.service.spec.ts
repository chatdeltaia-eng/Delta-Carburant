import { TransactionsService } from './transactions.service';

describe('TransactionsService import identity', () => {
  const service = new TransactionsService({} as never);
  const cardLast4 = (value:string) =>
    (service as unknown as {cardLast4(value:string):string}).cardLast4(value);
  const fingerprint = (row: Record<string, unknown>) =>
    (service as unknown as { transactionFingerprint(value: Record<string, unknown>, card: string): string })
      .transactionFingerprint(row, '790351');
  const isVehicleRegistration = (value:string) =>
    (service as unknown as {isVehicleRegistration(value:string):boolean}).isVehicleRegistration(value);

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

  it('utilise les 4 derniers chiffres du moyen de paiement pour toutes les sociétés', () => {
    expect(cardLast4('790351010836001404')).toBe('1404');
    expect(cardLast4('0001')).toBe('0001');
    expect(cardLast4('000109')).toBe('0109');
  });

  it('refuse un moyen de paiement incomplet', () => {
    expect(cardLast4('123')).toBe('');
  });

  it('distingue une vraie immatriculation Total des libellés descriptifs',()=>{
    expect(isVehicleRegistration('9459 TU 240')).toBe(true);
    expect(isVehicleRegistration('240-TU-9459')).toBe(true);
    expect(isVehicleRegistration('HORS PARC')).toBe(false);
    expect(isVehicleRegistration('C4')).toBe(false);
  });

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
