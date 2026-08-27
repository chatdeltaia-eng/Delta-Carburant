import { BadRequestException } from '@nestjs/common';
import { CardsService } from './cards.service';

describe('CardsService card identity', () => {
  const service=new CardsService({} as never);
  const canonical=(value:string)=>(service as unknown as {canonicalCardNumber(value:string):string}).canonicalCardNumber(value);

  it('conserve les quatre chiffres de carte du moyen de paiement Total',()=>{
    expect(canonical('000109')).toBe('0109');
    expect(canonical('790351010836001404')).toBe('1404');
    expect(canonical('CARTE-0007')).toBe('0007');
  });

  it('refuse une référence qui ne contient pas quatre chiffres',()=>{
    expect(()=>canonical('carte 12')).toThrow(BadRequestException);
  });
});
