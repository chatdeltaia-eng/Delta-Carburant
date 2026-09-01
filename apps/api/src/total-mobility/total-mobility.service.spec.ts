import { BadRequestException } from '@nestjs/common';
import { TotalMobilityService } from './total-mobility.service';
import { TotalLoginAgentService } from './total-login-agent.service';

describe('TotalMobilityService multi-company session sync', () => {
  const actor={sub:'00000000-0000-4000-8000-000000000001',email:'admin@delta.test'};
  const context={
    customerId:'customer-id',customerNumber:'10391',siteNumber:'10',
    userId:'user-id',username:'parc_auto',
  };
  const token='a'.repeat(64);

  it('harmonise uniquement les numéros Total contenant au moins 4 chiffres',()=>{
    const service=new TotalMobilityService({} as never,{} as never);
    const canonical=(value:string)=>(service as unknown as {canonicalTotalCardNumber(value:string):string})
      .canonicalTotalCardNumber(value);
    expect(canonical('790351010836001503')).toBe('1503');
    expect(canonical('001503')).toBe('1503');
    expect(canonical('15-03')).toBe('1503');
    expect(canonical('')).toBe('');
    expect(canonical('123')).toBe('');
  });

  it('conserve le numéro de carte distinct du numéro du mode de paiement',()=>{
    const service=new TotalMobilityService({} as never,{} as never);
    const official=(value:string)=>(service as unknown as {officialTotalCardNumber(value:string):string})
      .officialTotalCardNumber(value);
    const fromPayment=(value:string)=>(service as unknown as {cardNumberFromPaymentMethod(value:string):string})
      .cardNumberFromPaymentMethod(value);
    expect(official('0033')).toBe('0033');
    expect(official('1')).toBe('0001');
    expect(official('02')).toBe('0002');
    expect(official('790351010836001503')).toBe('1503');
    expect(fromPayment('0033 0 8')).toBe('0033');
    expect(fromPayment('004108')).toBe('0041');
  });

  it('conserve un plafond Total explicitement lu à zéro lors de la fusion',()=>{
    const agent=new TotalLoginAgentService({} as never,{} as never);
    const unique=(cards:unknown[])=>(agent as unknown as {uniqueCards(value:unknown[]):unknown[]}).uniqueCards(cards);
    expect(unique([
      {cardNumber:'0001',paymentMethodNumber:'0001 0 1',status:'VALIDE',monthlyLimit:500},
      {cardNumber:'0001',paymentMethodNumber:'0001 0 1',status:'VALIDE',monthlyLimit:0},
    ])).toEqual([expect.objectContaining({cardNumber:'0001',monthlyLimit:0})]);
  });

  it('normalise les quatre derniers chiffres du moyen de paiement pour les transactions',()=>{
    const service=new TotalMobilityService({} as never,{} as never);
    const canonical=(value:string)=>(service as unknown as {canonicalTotalCardNumber(value:string):string})
      .canonicalTotalCardNumber(value);
    expect(canonical('0001 0 8')).toBe('0108');
    expect(canonical('790351010836001503')).toBe('1503');
  });

  it('lit uniquement la limite produit carte et ignore la limite de crédit client',()=>{
    const agent=new TotalLoginAgentService({} as never,{} as never);
    const read=(value:unknown)=>(agent as unknown as {cardProductLimitFromUnknown(value:unknown):number|undefined})
      .cardProductLimitFromUnknown(value);
    expect(read({customer:{creditLimit:16000},cardProduct:{monthlyLimit:700}})).toBe(700);
    expect(read({cardProduct:{limit:0}})).toBe(0);
    expect(read({cardProduct:{limit:500,ceiling:700}})).toBeUndefined();
  });

  it.each([
    ['DC','DELTA CUISINE'],
    ['DCD','DELTA CUISINE DISTRIBUTION'],
    ['TCM','STE LES TECHNIQUES DE MARBRE'],
    ['IKIT','IKIT TN'],
  ])('importe %s uniquement depuis son client Total %s',async(code,clientName)=>{
    const db={query:jest.fn().mockResolvedValue([{code}])};
    const transactions={};
    const service=new TotalMobilityService(db as never,transactions as never);
    const remote=[{transactionDate:'2026-08-20',cardNumber:'1234'}];
    jest.spyOn(service as never,'fetchAll').mockResolvedValue(remote as never);
    const imported=jest.spyOn(service,'importBrowserTransactions').mockResolvedValue({fetched:1} as never);

    await service.syncClientWithAccessToken(actor,token,'00000000-0000-4000-8000-000000000002',clientName,context,'2026-08-01');

    expect(imported).toHaveBeenCalledWith(remote,actor,clientName,'2026-08-01');
  });

  it('refuse de mélanger un client Total et une autre société Delta',async()=>{
    const db={query:jest.fn().mockResolvedValue([{code:'DCD'}])};
    const service=new TotalMobilityService(db as never,{} as never);
    await expect(service.syncClientWithAccessToken(
      actor,token,'00000000-0000-4000-8000-000000000002','DELTA CUISINE',context,
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});
