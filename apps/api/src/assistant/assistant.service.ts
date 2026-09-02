import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { MailingService } from '../mailing/mailing.service';

type Actor={sub:string;role:string;email:string};
type Intent={startDate:string|null;endDate:string|null;card:string|null;vehicle:string|null;beneficiary:string|null;navigation:string|null;emailRequested:boolean;emailRecipient:'DIRECTION'|'KHALED'|null};
type OpenAIResponse={output_text?:string;output?:{type?:string;content?:{type?:string;text?:string}[]}[]};

@Injectable()
export class AssistantService {
  constructor(private readonly db:DatabaseService,private readonly mail:MailingService) {}

  private async model(input:string,instructions:string,jsonSchema?:Record<string,unknown>) {
    if(!process.env.OPENAI_API_KEY)throw new Error('OpenAI non configuré');
    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      signal:AbortSignal.timeout(12_000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:JSON.stringify({
        model:process.env.OPENAI_ASSISTANT_MODEL??'gpt-5-mini',
        store:false,
        instructions,
        input,
        max_output_tokens:jsonSchema?500:900,
        ...(jsonSchema?{text:{format:{type:'json_schema',name:'assistant_result',strict:true,schema:jsonSchema}}}:{}),
      }),
    });
    if(!response.ok) throw new Error(`OpenAI ${response.status}`);
    const payload=await response.json() as OpenAIResponse;
    return payload.output_text??payload.output?.flatMap(item=>item.content??[]).find(item=>item.type==='output_text')?.text??'';
  }

  private async understand(question:string) {
    const today=new Date().toISOString().slice(0,10);
    const schema={type:'object',additionalProperties:false,required:['startDate','endDate','card','vehicle','beneficiary','navigation','emailRequested','emailRecipient'],properties:{
      startDate:{type:['string','null'],description:'YYYY-MM-DD inclus'},endDate:{type:['string','null'],description:'YYYY-MM-DD inclus'},
      card:{type:['string','null']},vehicle:{type:['string','null']},beneficiary:{type:['string','null']},
      navigation:{type:['string','null'],enum:['dashboard','reports','cards','beneficiaries','vehicles','drivers','fuelPrices','transactions','requests','mileage','anomalies','complaints','returns','documents','settings',null]},
      emailRequested:{type:'boolean'},emailRecipient:{type:['string','null'],enum:['DIRECTION','KHALED',null]},
    }};
    try{
      const text=await this.model(question,`Nous sommes le ${today}. Extrais uniquement les filtres explicites ou implicites de la question française. Pour un mois, utilise son premier et dernier jour. Pour « ce mois », utilise le mois courant. Une demande d'ouverture/navigation renseigne navigation. Si l'utilisateur demande d'envoyer ou préparer un e-mail, emailRequested=true. Le destinataire autorisé est seulement DIRECTION ou KHALED.`,schema);
      return JSON.parse(text) as Intent;
    }catch{return this.localIntent(question);}
  }

  private localIntent(question:string):Intent {
    const normalized=question.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const destinations:Record<string,string[]>={dashboard:['accueil','tableau de bord','vue d ensemble'],reports:['rapport','analyse'],cards:['carte'],beneficiaries:['beneficiaire'],vehicles:['vehicule','voiture'],drivers:['chauffeur'],fuelPrices:['prix carburant'],transactions:['transaction','consommation'],requests:['demande'],mileage:['kilometrage','km'],anomalies:['anomalie','alerte'],complaints:['reclamation'],returns:['restitution'],documents:['facture','document'],settings:['parametre']};
    const navigation=Object.entries(destinations).find(([,words])=>words.some(word=>normalized.includes(word)))?.[0]??null;
    const months=['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre'];
    const monthIndex=months.findIndex(month=>normalized.includes(month));
    const year=Number(normalized.match(/\b20\d{2}\b/)?.[0]??new Date().getFullYear());
    let startDate:string|null=null,endDate:string|null=null;
    if(monthIndex>=0){
      startDate=`${year}-${String(monthIndex+1).padStart(2,'0')}-01`;
      endDate=new Date(Date.UTC(year,monthIndex+1,0)).toISOString().slice(0,10);
    }else if(/ce mois|mois actuel|mois courant/.test(normalized)){
      const now=new Date();startDate=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;endDate=new Date(Date.UTC(now.getFullYear(),now.getMonth()+1,0)).toISOString().slice(0,10);
    }
    return {startDate,endDate,card:normalized.match(/(?:carte\s*)?(\d{4})\b/)?.[1]??null,vehicle:null,beneficiary:null,navigation,emailRequested:/\b(?:envoi|envoie|envoyer|mail|email|e-mail)\b/.test(normalized),emailRecipient:normalized.includes('khaled')?'KHALED':/\bdg\b|direction/.test(normalized)?'DIRECTION':null};
  }

  private localAnswer(question:string,data:Record<string,unknown>) {
    const normalized=question.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const summary=(data.summary??{}) as Record<string,unknown>;
    const entities=(data.entities??{}) as Record<string,unknown>;
    const filters=data.filters as Intent;
    const period=filters.startDate&&filters.endDate?`du ${filters.startDate} au ${filters.endDate}`:'sur la période disponible';
    const number=(value:unknown,digits=3)=>Number(value??0).toLocaleString('fr-FR',{maximumFractionDigits:digits});
    if(normalized.includes('anomal'))return `${(data.anomalies as unknown[]).length} anomalie(s) récente(s) sont disponibles dans votre périmètre.`;
    if(normalized.includes('chauffeur'))return `${number(entities.drivers,0)} chauffeur(s) sont enregistrés dans le périmètre sélectionné.`;
    if(normalized.includes('vehicule')||normalized.includes('voiture'))return `${number(entities.vehicles,0)} véhicule(s) sont enregistrés dans le périmètre sélectionné.`;
    if(normalized.includes('carte')&&!normalized.includes('consomm')){
      const cards=data.cards as unknown[];return `${cards.length} carte(s) sont accessibles dans le périmètre sélectionné.`;
    }
    const cards=data.byCard as Record<string,unknown>[];
    const exceeded=cards.filter(card=>Number(card.monthlyLimit??0)>0&&Number(card.amount??0)>=Number(card.monthlyLimit));
    return `La consommation ${period} est de ${number(summary.amount)} TND pour ${number(summary.liters,2)} litres et ${number(summary.transactions,0)} transaction(s). ${exceeded.length} carte(s) ont atteint ou dépassé leur plafond.`;
  }

  private scope(actor:Actor,companyId?:string) {
    return {own:actor.role==='NAJIB_ASSIGNER',userId:actor.sub,companyId:companyId??''};
  }

  private async businessData(intent:Intent,actor:Actor,companyId?:string) {
    const s=this.scope(actor,companyId);
    const args=[s.own,s.userId,s.companyId,intent.startDate,intent.endDate,intent.card??'',intent.vehicle??'',intent.beneficiary??''];
    const filter=`fc.deleted_at IS NULL AND ft.deleted_at IS NULL
      AND ($1::boolean=false OR fc.responsible_user_id=$2::uuid) AND ($3::text='' OR fc.company_id=$3::uuid)
      AND ($4::text IS NULL OR ft.transaction_date>=$4::date) AND ($5::text IS NULL OR ft.transaction_date<$5::date+interval '1 day')
      AND ($6='' OR right(regexp_replace(fc.masked_card_number,'[^0-9]','','g'),4)=right(regexp_replace($6,'[^0-9]','','g'),4))
      AND ($7='' OR regexp_replace(lower(coalesce(v.registration_display,'')),'[^a-z0-9]','','g') LIKE '%'||regexp_replace(lower($7),'[^a-z0-9]','','g')||'%')
      AND ($8='' OR lower(coalesce(b.display_name,fc.holder_name,'')) LIKE '%'||lower($8)||'%')`;
    const [summary,byCard,byMonth,byDay,byVehicle,byProduct,byStation,cards,requests,anomalies,entities,mileage,fuelPrices,complaints,receipts,imports,quality,totalSync,audit]=await Promise.all([
      this.db.query(`SELECT count(ft.id)::int transactions,coalesce(sum(ft.amount_incl_tax),0)::float amount,coalesce(sum(ft.quantity_liters),0)::float liters,
        coalesce(avg(ft.amount_incl_tax),0)::float "averageTransaction",min(ft.transaction_date) "firstDate",max(ft.transaction_date) "lastDate"
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter}`,args),
      this.db.query(`SELECT fc.masked_card_number card,coalesce(b.display_name,fc.holder_name) beneficiary,coalesce(v.registration_display,fc.official_registration) vehicle,
        fc.monthly_limit::float "monthlyLimit",sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions,
        CASE WHEN fc.monthly_limit>0 THEN round(100*sum(ft.amount_incl_tax)/fc.monthly_limit,1)::float ELSE 0 END rate
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter}
        GROUP BY fc.id,b.display_name,v.registration_display ORDER BY amount DESC LIMIT 200`,args),
      this.db.query(`SELECT to_char(date_trunc('month',ft.transaction_date),'YYYY-MM') AS "month",sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter} GROUP BY 1 ORDER BY 1`,args),
      this.db.query(`SELECT to_char(ft.transaction_date,'YYYY-MM-DD') day,sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter} GROUP BY 1 ORDER BY 1 DESC LIMIT 370`,args),
      this.db.query(`SELECT coalesce(v.registration_display,fc.official_registration,'Non identifié') vehicle,sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter} GROUP BY 1 ORDER BY amount DESC LIMIT 100`,args),
      this.db.query(`SELECT coalesce(ft.product,'Non renseigné') product,sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter} GROUP BY 1 ORDER BY amount DESC LIMIT 100`,args),
      this.db.query(`SELECT coalesce(ft.station,'Non renseignée') station,sum(ft.amount_incl_tax)::float amount,sum(ft.quantity_liters)::float liters,count(*)::int transactions
        FROM fuel_transaction ft JOIN fuel_card fc ON fc.id=ft.fuel_card_id LEFT JOIN vehicle v ON v.id=ft.vehicle_id LEFT JOIN beneficiary b ON b.id=ft.beneficiary_id WHERE ${filter} GROUP BY 1 ORDER BY amount DESC LIMIT 100`,args),
      this.db.query(`SELECT fc.masked_card_number card,fc.status,fc.monthly_limit::float "monthlyLimit",fc.holder_name holder,fc.official_registration vehicle,c.code company
        FROM fuel_card fc JOIN company c ON c.id=fc.company_id WHERE fc.deleted_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2::uuid) AND ($3::text='' OR fc.company_id=$3::uuid) ORDER BY fc.masked_card_number LIMIT 500`,args.slice(0,3)),
      this.db.query(`SELECT cr.request_number number,cr.request_type type,cr.status,cr.priority,cr.reason,cr.requested_limit::float "requestedLimit",cr.created_at "createdAt"
        FROM card_request cr LEFT JOIN fuel_card fc ON fc.id=cr.fuel_card_id WHERE ($1::boolean=false OR cr.requested_by=$2::uuid) AND ($3::text='' OR fc.company_id=$3::uuid) ORDER BY cr.created_at DESC LIMIT 100`,args.slice(0,3)),
      this.db.query(`SELECT a.anomaly_type type,a.severity,a.status,a.description,a.created_at "createdAt" FROM anomaly a LEFT JOIN fuel_card fc ON fc.id=a.fuel_card_id
        WHERE ($1::boolean=false OR fc.responsible_user_id=$2::uuid) AND ($3::text='' OR fc.company_id=$3::uuid) ORDER BY a.created_at DESC LIMIT 100`,args.slice(0,3)),
      this.db.query(`SELECT (SELECT count(*) FROM vehicle v WHERE v.deleted_at IS NULL AND ($3::text='' OR v.company_id=$3::uuid))::int vehicles,
        (SELECT count(*) FROM driver d WHERE d.deleted_at IS NULL AND ($3::text='' OR d.company_id=$3::uuid))::int drivers,
        (SELECT count(*) FROM beneficiary b WHERE b.active AND ($3::text='' OR b.company_id=$3::uuid))::int beneficiaries`,args.slice(0,3)),
      this.db.query(`SELECT coalesce(v.registration_display,'Non identifié') vehicle,max(mr.mileage)::float "lastMileage",max(mr.reading_date) "lastReading",
        count(*)::int readings,count(*) FILTER (WHERE mr.status='PENDING')::int pending,count(*) FILTER (WHERE mr.status='REJECTED')::int rejected
        FROM mileage_reading mr JOIN vehicle v ON v.id=mr.vehicle_id LEFT JOIN beneficiary b ON b.id=mr.beneficiary_id
        WHERE ($1::boolean=false OR b.id=(SELECT beneficiary_id FROM app_user WHERE id=$2::uuid)) AND ($3::text='' OR v.company_id=$3::uuid)
          AND ($4::text IS NULL OR mr.reading_date>=$4::date) AND ($5::text IS NULL OR mr.reading_date<$5::date+interval '1 day')
        GROUP BY v.registration_display ORDER BY "lastReading" DESC LIMIT 120`,args.slice(0,5)),
      this.db.query(`SELECT c.code company,fp.product,fp.old_price::float "oldPrice",fp.new_price::float "newPrice",fp.variation_percent::float "variationPercent",fp.effective_date "effectiveDate"
        FROM fuel_price fp JOIN company c ON c.id=fp.company_id
        WHERE ($3::text='' OR fp.company_id=$3::uuid) ORDER BY fp.effective_date DESC LIMIT 120`,args.slice(0,3)),
      this.db.query(`SELECT complaint_number number,subject,priority,status,target_role "targetRole",created_at "createdAt",resolved_at "resolvedAt"
        FROM complaint WHERE ($1::boolean=false OR created_by=$2::uuid) ORDER BY created_at DESC LIMIT 100`,args.slice(0,2)),
      this.db.query(`SELECT cdr.receipt_number number,cdr.status,cdr.issued_at "issuedAt",fc.masked_card_number card,b.display_name beneficiary,v.registration_display vehicle
        FROM card_distribution_receipt cdr JOIN fuel_card fc ON fc.id=cdr.fuel_card_id LEFT JOIN beneficiary b ON b.id=cdr.beneficiary_id LEFT JOIN vehicle v ON v.id=cdr.vehicle_id
        WHERE fc.deleted_at IS NULL AND ($1::boolean=false OR fc.responsible_user_id=$2::uuid) AND ($3::text='' OR fc.company_id=$3::uuid)
        ORDER BY cdr.created_at DESC LIMIT 100`,args.slice(0,3)),
      this.db.query(`SELECT source_name source,status,total_rows "totalRows",accepted_rows "acceptedRows",warning_rows "warningRows",rejected_rows "rejectedRows",started_at "startedAt",completed_at "completedAt",error_message "errorMessage"
        FROM import_batch ORDER BY started_at DESC LIMIT 80`),
      this.db.query(`SELECT entity_type "entityType",issue_code "issueCode",severity,count(*)::int count
        FROM data_quality_issue WHERE resolved_at IS NULL GROUP BY entity_type,issue_code,severity ORDER BY count DESC LIMIT 80`),
      this.db.query(`SELECT status,started_at "startedAt",finished_at "finishedAt",fetched_rows "fetchedRows",imported_rows "importedRows",duplicate_rows "duplicateRows",review_rows "reviewRows",error_message "errorMessage",metadata
        FROM total_mobility_sync_run ORDER BY started_at DESC LIMIT 20`).catch(()=>[]),
      this.db.query(`SELECT action,entity_type "entityType",entity_id "entityId",created_at "createdAt"
        FROM audit_log ORDER BY created_at DESC LIMIT 80`),
    ]);
    return {filters:intent,summary:summary[0],byCard,byMonth,byDay,byVehicle,byProduct,byStation,cards,requests,anomalies,entities:entities[0],mileage,fuelPrices,complaints,receipts,imports,quality,totalSync,audit};
  }

  async ask(dto:{question:string;companyId?:string;history?:{role:'user'|'assistant';text:string}[]},actor:Actor) {
    const intent=await this.understand(dto.question);
    if(intent.navigation&&!/[?]|combien|quel|quelle|consomm|montant|plafond|analyse|compare/i.test(dto.question))
      return {answer:`Je vous dirige vers ${intent.navigation}.`,navigate:intent.navigation};
    const data=await this.businessData(intent,actor,dto.companyId);
    const recent=(dto.history??[]).slice(-8).map(item=>`${item.role}: ${item.text}`).join('\n');
    let answer:string;
    try{answer=await this.model(`Historique:\n${recent}\n\nQuestion: ${dto.question}\n\nDonnées autorisées et actualisées:\n${JSON.stringify(data)}`,
      `Tu es l'assistant métier Delta Carburant, présent dans tous les modules. Réponds en français, clairement et brièvement, uniquement avec les données fournies. Tu peux aider sur cartes, consommations, transactions, plafonds, dépassements, véhicules, chauffeurs, bénéficiaires, kilométrage, anomalies, demandes, réclamations, reçus, documents, imports, qualité de données, audits et synchronisation Total. Calcule, compare et explique si nécessaire. Respecte les filtres et indique la période utilisée. Les montants sont en TND et les volumes en litres. Ne prétends jamais qu'une donnée absente vaut zéro. N'invente rien. Si la question demande une action sensible ou une modification, explique la procédure et demande confirmation sans effectuer l'action.`,undefined);}
    catch{answer=this.localAnswer(dto.question,data);}
    return {answer:intent.emailRequested?`${answer}\n\nL’e-mail est prêt. Confirmez-vous l’envoi ?`:answer,navigate:intent.navigation??null,filters:intent,
      action:intent.emailRequested?{type:'SEND_CONSUMPTION_EMAIL',recipient:intent.emailRecipient??'DIRECTION',requiresConfirmation:true}:null,
      requestId:createHash('sha256').update(`${actor.sub}:${Date.now()}`).digest('hex').slice(0,16)};
  }

  async sendConsumptionEmail(dto:{question:string;companyId?:string;history?:{role:'user'|'assistant';text:string}[]},actor:Actor){
    const intent=await this.understand(dto.question);
    const data=await this.businessData(intent,actor,dto.companyId);
    let content:string;
    try{content=await this.model(`Demande confirmée: ${dto.question}\nDonnées autorisées: ${JSON.stringify(data)}`,
      `Rédige un rapport e-mail professionnel en français sur la consommation demandée. Donne la période, les totaux, les sociétés/cartes utiles et les dépassements. Utilise uniquement les données fournies. Texte brut concis.`,undefined);}
    catch{content=this.localAnswer(dto.question,data);}
    const configured=(process.env.DIRECTION_MAIL_TO||'khaled.sfaxi@deltacuisine.com').split(',').map(value=>value.trim()).filter(Boolean);
    const khaled=process.env.KHALED_MAIL_TO?.trim()||'khaled.sfaxi@deltacuisine.com';
    const recipients=intent.emailRecipient==='KHALED'?[khaled]:configured;
    const escape=(value:string)=>value.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]!));
    const result=await this.mail.send(recipients,`Rapport consommation Delta Carburant — ${new Date().toLocaleDateString('fr-TN')}`,
      `<div style="font-family:Arial,sans-serif;max-width:820px;color:#18344a"><h2>Rapport demandé depuis l’assistant Delta IA</h2><p style="white-space:pre-line;line-height:1.65">${escape(content)}</p><hr><small>Demande confirmée par ${escape(actor.email)}.</small></div>`);
    await this.db.query(`INSERT INTO management_mail_log(report_type,recipients,status,details) VALUES('ASSISTANT_CONSUMPTION',$1,$2,$3)`,[recipients,result.sent?'SENT':'SKIPPED',{actor:actor.email,question:dto.question,...result}]);
    return {...result,recipients,answer:result.sent?`E-mail envoyé à ${recipients.join(', ')}.`:'E-mail non envoyé : vérifiez la configuration SMTP Render.'};
  }
}
