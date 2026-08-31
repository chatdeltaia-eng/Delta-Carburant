import { BadRequestException } from '@nestjs/common';
import { TotalMobilityService } from './total-mobility.service';

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
    expect(official('0033')).toBe('0033');
    expect(official('0033 0 8')).toBe('0033');
    expect(official('004108')).toBe('0041');
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
