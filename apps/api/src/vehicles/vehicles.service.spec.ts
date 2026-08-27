import { VehiclesService } from './vehicles.service';

describe('VehiclesService Total reconciliation',()=>{
  it('recherche les cartes uniquement dans la société du véhicule',async()=>{
    const queries:string[]=[];
    const client={query:jest.fn(async(sql:string)=>{
      queries.push(sql);
      if(sql.includes('SELECT id,masked_card_number'))return {rows:[],rowCount:0};
      return {rows:[],rowCount:0};
    })};
    const db={transaction:jest.fn(async(work:(value:typeof client)=>unknown)=>work(client))};
    const service=new VehiclesService(db as never);
    await (service as unknown as {reconcileTotalCards(vehicleId:string,companyId:string,registration:string,actorId:string):Promise<unknown>})
      .reconcileTotalCards('vehicle-dcd','company-dcd','9459 TU 240','actor');
    const lookup=queries.find(sql=>sql.includes('SELECT id,masked_card_number'))??'';
    expect(lookup).toContain('company_id=$2');
  });
});
