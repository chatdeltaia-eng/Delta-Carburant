import { BadRequestException,Injectable } from '@nestjs/common'; import { DatabaseService } from '../database/database.service'; import type { PoolClient } from 'pg';
@Injectable() export class FuelPricesService{constructor(private readonly db:DatabaseService){}
 private readonly officialUrl='https://www.energiemines.gov.tn/fr/themes/energie/hydrocarbures/prix-et-marges-des-produits-petroliers/';
 private parseFrenchDate(value:string){
  const normalized=value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,' ').replace(/\s+/g,' ');
  const match=normalized.match(/(\d{1,2})\s*(?:er\s*)?(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4,5})/);
  if(!match)return null;
  const months=['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre'];
  const year=Number(match[3]); if(year<2000||year>2100)return null;
  return `${year}-${String(months.indexOf(match[2])+1).padStart(2,'0')}-${String(Number(match[1])).padStart(2,'0')}`;
 }
 private parseOfficialHistory(html:string){
  const decode=(value:string)=>value.replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&eacute;/gi,'é').replace(/&egrave;/gi,'è').replace(/&ecirc;/gi,'ê').replace(/&agrave;/gi,'à').replace(/&acirc;/gi,'â').replace(/&ucirc;/gi,'û').replace(/&ocirc;/gi,'ô').replace(/&icirc;/gi,'î').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim();
  const entries:{product:string;price:number;effectiveDate:string}[]=[]; let effectiveDate:string|null=null;
  for(const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi)??[]){
   const cells=(row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi)??[]).map(decode);
   const rowDate=cells.map(cell=>this.parseFrenchDate(cell)).filter((date):date is string=>Boolean(date)).at(-1);
   if(rowDate)effectiveDate=rowDate;
   const productCell=cells.find(cell=>/essence\s+sans\s+plomb|gasoil\s+sans\s+soufre|gasoil\s+ordinaire/i.test(cell));
   const priceText=[...cells].reverse().find(cell=>/^\d{4}$/.test(cell));
   if(!productCell||!priceText||!effectiveDate)continue;
   const key=productCell.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
   const product=key.includes('essence')?'ESSENCE SANS PLOMB':key.includes('sans soufre')?'GASOIL SANS SOUFRE (GASOIL 50)':'GASOIL ORDINAIRE';
   entries.push({product,price:Number(priceText)/1000,effectiveDate});
  }
  return entries.filter(item=>item.price>=1&&item.price<=5);
 }
 private async recalculateBilling(client:PoolClient,companyId:string){
  const result=await client.query(`WITH priced AS (
    SELECT ft.id,ft.quantity_liters,ft.amount_incl_tax,price.new_price
    FROM fuel_transaction ft
    JOIN fuel_card fc ON fc.id=ft.fuel_card_id
    LEFT JOIN LATERAL (
      SELECT fp.new_price FROM fuel_price fp
      WHERE fp.company_id=fc.company_id AND upper(fp.product)=CASE
        WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOIL','GO','DIESEL') THEN 'GASOIL ORDINAIRE'
        WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASOILSS','GASOIL50','GOSSO') THEN 'GASOIL SANS SOUFRE (GASOIL 50)'
        WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SUPERSP','SSP','ESSENCE','ESSENCESANSPLOMB') THEN 'ESSENCE SANS PLOMB'
        WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('GASEXC','GASSEXC','GASOILEXC','GOSSEXC','GASOILSSEXC','GASOIL50EXC','GASOILPOWER') THEN 'GASOIL PREMIUM / POWER'
        WHEN regexp_replace(upper(coalesce(ft.product,'')),'[^A-Z0-9]','','g') IN ('SSPEXC','SUPEREXC','ESSENCEEXC','ESSENCEPOWER') THEN 'ESSENCE PREMIUM / POWER'
        ELSE upper(trim(coalesce(ft.product,''))) END
      ORDER BY (fp.effective_date<=ft.transaction_date::date) DESC,
        CASE WHEN fp.effective_date<=ft.transaction_date::date THEN fp.effective_date END DESC,
        CASE WHEN fp.effective_date>ft.transaction_date::date THEN fp.effective_date END ASC,
        fp.created_at DESC LIMIT 1
    ) price ON true
    WHERE ft.deleted_at IS NULL AND fc.company_id=$1
  ), calculated AS (
    SELECT id,new_price,round(quantity_liters*new_price,3) expected,
      round(amount_incl_tax-round(quantity_liters*new_price,3),3) difference
    FROM priced WHERE new_price IS NOT NULL
  ), updated_priced AS (
    UPDATE fuel_transaction ft SET unit_price=c.new_price,expected_amount=c.expected,
      billing_difference=c.difference,validation_status=CASE WHEN abs(c.difference)<=greatest(.05,c.expected*.005)
        THEN 'BILLING_OK' ELSE 'BILLING_MISMATCH' END,billing_checked_at=now()
    FROM calculated c WHERE ft.id=c.id RETURNING ft.validation_status
  ), updated_unpriced AS (
    UPDATE fuel_transaction ft SET unit_price=null,expected_amount=null,billing_difference=null,
      validation_status='PRICE_UNAVAILABLE',billing_checked_at=now()
    WHERE ft.id IN (SELECT id FROM priced WHERE new_price IS NULL) RETURNING ft.id
  ) SELECT count(*)::int AS checked,
    count(*) FILTER(WHERE validation_status='BILLING_OK')::int AS verified,
    count(*) FILTER(WHERE validation_status='BILLING_MISMATCH')::int AS mismatches,
    (SELECT count(*)::int FROM updated_unpriced) AS unpriced FROM updated_priced`,[companyId]);
  return result.rows[0]??{checked:0,verified:0,mismatches:0,unpriced:0};
 }
 list(companyId:string){return this.db.query(`SELECT fp.id,fp.company_id AS "companyId",c.code AS company,fp.product,fp.old_price AS "oldPrice",fp.new_price AS "newPrice",fp.variation_percent AS "variationPercent",fp.effective_date AS "effectiveDate",u.display_name AS "createdBy",fp.created_at AS "createdAt",fp.source,fp.source_url AS "sourceUrl" FROM fuel_price fp JOIN company c ON c.id=fp.company_id LEFT JOIN app_user u ON u.id=fp.created_by WHERE ($1='' OR fp.company_id=$1::uuid) ORDER BY fp.effective_date DESC,fp.created_at DESC`,[companyId]);}
 async refreshTunisia(actor:{sub:string;email:string}){
  let html='';try{const response=await fetch(this.officialUrl,{headers:{'user-agent':'DeltaCarburant/1.0 price-monitor'}});if(!response.ok)throw new Error(String(response.status));html=await response.text();}catch{throw new BadRequestException('Source officielle tunisienne temporairement inaccessible');}
  const history=this.parseOfficialHistory(html);
  const latest=[...new Map(history.map(item=>[item.product,item])).values()];
  if(latest.length!==3)throw new BadRequestException('Format de la source officielle modifié : les trois carburants réglementés n’ont pas été trouvés');
  return this.db.transaction(async client=>{const company=await client.query(`SELECT id FROM company WHERE code='DC' AND active LIMIT 1`);if(!company.rows[0])throw new BadRequestException('Société DC introuvable');let changed=0;
   const before=new Map<string,number>();
   for(const item of latest){const previous=await client.query(`SELECT new_price FROM fuel_price WHERE company_id=$1 AND product=$2 ORDER BY effective_date DESC,created_at DESC LIMIT 1`,[company.rows[0].id,item.product]);if(previous.rows[0])before.set(item.product,Number(previous.rows[0].new_price));}
   let imported=0;
   for(const item of history){const previous=await client.query(`SELECT new_price FROM fuel_price WHERE company_id=$1 AND product=$2 AND effective_date<$3::date ORDER BY effective_date DESC,created_at DESC LIMIT 1`,[company.rows[0].id,item.product,item.effectiveDate]);const old=Number(previous.rows[0]?.new_price??item.price);const variation=old?100*(item.price-old)/old:0;
    const inserted=await client.query(`INSERT INTO fuel_price(company_id,product,old_price,new_price,variation_percent,effective_date,created_by,source,source_url)
      SELECT $1,$2,$3,$4,$5,$6::date,$7,'OFFICIAL_TUNISIA',$8 WHERE NOT EXISTS(SELECT 1 FROM fuel_price WHERE company_id=$1 AND product=$2 AND effective_date=$6::date AND source='OFFICIAL_TUNISIA') RETURNING id`,[company.rows[0].id,item.product,old,item.price,variation,item.effectiveDate,actor.sub,this.officialUrl]);imported+=inserted.rowCount??0;}
   for(const item of latest){const old=before.get(item.product);if(old===undefined||old===item.price)continue;const variation=100*(item.price-old)/old;changed++;
    await client.query(`INSERT INTO notification(user_id,title,message,severity,target_view,entity_type,entity_id) SELECT id,$1,$2,'WARNING','fuelPrices','fuel_price',NULL FROM app_user WHERE active AND role IN('ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN')`,[`Prix carburant en Tunisie ${variation>0?'augmenté':'diminué'}`,`${item.product} : ${old.toFixed(3)} → ${item.price.toFixed(3)} TND/l (${variation.toFixed(2)} %), applicable le ${item.effectiveDate}`]);}
   const billing=await this.recalculateBilling(client,company.rows[0].id);
   await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'REFRESH_TUNISIA','fuel_price','OFFICIAL',$2)`,[actor.email,{source:this.officialUrl,prices:latest,historyImported:imported,changed,billing}]);return {source:this.officialUrl,checked:latest.length,changed,prices:latest,historyImported:imported,billing,scope:'3 carburants réglementés publiés par le ministère'};});
 }
 async create(dto:{companyId:string;product:string;newPrice:number;effectiveDate?:string},actor:{sub:string;email:string}){return this.db.transaction(async client=>{
  const previous=await client.query(`SELECT new_price FROM fuel_price WHERE company_id=$1 AND lower(product)=lower($2) ORDER BY effective_date DESC,created_at DESC LIMIT 1`,[dto.companyId,dto.product.trim()]);
  const oldPrice=Number(previous.rows[0]?.new_price??dto.newPrice); if(oldPrice<=0)throw new BadRequestException('Ancien prix invalide'); const variation=100*(dto.newPrice-oldPrice)/oldPrice;
  const created=await client.query(`INSERT INTO fuel_price(company_id,product,old_price,new_price,variation_percent,effective_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[dto.companyId,dto.product.trim(),oldPrice,dto.newPrice,variation,dto.effectiveDate??new Date().toISOString().slice(0,10),actor.sub]);
  if(Math.abs(variation)>0){await client.query(`UPDATE fuel_card SET monthly_limit=round(monthly_limit*(1+$2/100),3) WHERE company_id=$1 AND deleted_at IS NULL AND monthly_limit>0`,[dto.companyId,variation]);
   await client.query(`INSERT INTO notification(user_id,title,message,target_view,entity_type,entity_id) SELECT id,'Plafonds ajustés au prix carburant',$2,'cards','fuel_price',$3 FROM app_user WHERE active AND (company_id=$1 OR role IN('ZIN_FINANCE','DIRECTION_GENERAL','SUPER_ADMIN'))`,[dto.companyId,`Le prix ${dto.product} varie de ${variation.toFixed(2)} %. Les plafonds de la société ont été ajustés dans la même proportion.`,created.rows[0].id]);}
  const billing=await this.recalculateBilling(client,dto.companyId);
  await client.query(`INSERT INTO audit_log(actor,action,entity_type,entity_id,new_values) VALUES($1,'FUEL_PRICE_CHANGE','fuel_price',$2,$3)`,[actor.email,created.rows[0].id,{oldPrice,newPrice:dto.newPrice,variation,billing}]);return {id:created.rows[0].id,oldPrice,newPrice:dto.newPrice,variationPercent:variation,limitsUpdated:Math.abs(variation)>0,billing};});}}
