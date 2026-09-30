import fs from 'node:fs/promises';
import path from 'node:path';
import { NL, VERSION, norm, brl, dateKey, amount, date, fields, get, rpOf, hash, fresh } from './prime-test-utils.mjs';
import { execute } from './prime-test-actions.mjs';
import { operation, agenda, account } from './prime-test-records.mjs';
import { accounts, summary, help } from './prime-test-reports.mjs';
export class Engine {
 constructor(file=null,now=()=>new Date()){if(file&&path.basename(file)!=='prime-test-v3.json')throw Error('Arquivo deve ser isolado prime-test-v3.json');this.file=file;this.now=now;this.s=fresh();this.queue=Promise.resolve();}
 async initialize(){if(!this.file)return;await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});try{const s=JSON.parse(await fs.readFile(this.file,'utf8'));if(s.schema!==3||s.mode!=='TEST'||!Array.isArray(s.operations))throw Error('Base de teste inválida.');this.s=s;}catch(e){if(e.code!=='ENOENT')throw e;}await this.save();}
 async save(){if(!this.file)return;const tmp=`${this.file}.tmp`;const h=await fs.open(tmp,'w',0o600);try{await h.writeFile(JSON.stringify(this.s));await h.sync();}finally{await h.close();}await fs.rename(tmp,this.file);}
 today(){return dateKey(this.now());}
 event(e,action,op=null,detail={}){this.s.events.push({at:this.now().toISOString(),actor:e.actor,group:e.group,message:e.id,operation:op?.id,action,...detail});}
 privileged(e){return e.owner||(e.admin&&e.role==='report');}
 require(e,roles=['FINANCEIRO']){if(!this.privileged(e)&&!roles.includes(this.s.roles[e.actor]))throw Error('Acesso não autorizado. Cadastre o papel no grupo PRIME | ATUALIZAÇÕES com um administrador.');}
 reportAccess(e){if(e.role!=='report')throw Error('Faça esta consulta no grupo PRIME | ATUALIZAÇÕES.');this.require(e,['FINANCEIRO','SOCIO','REVISOR']);}
 id(rp){const [y,m,d]=this.today().split('-');const b=`TESTE-PRIME-${d}${m}${y.slice(2)}-${rp}`;const n=(this.s.sequence[b]||0)+1;this.s.sequence[b]=n;return `${b}-${String(n).padStart(4,'0')}`;}
 target(e){const written=String(e.text).match(/TESTE-PRIME-\d{6}-(?:RP[1-5]|ADM)-\d{4,}/i)?.[0]?.toUpperCase();const q=e.quoteId&&(this.s.messages[`${e.group}|${e.quoteId}`]?.operation||this.s.outbound[`${e.group}|${e.quoteId}`]?.operation);if(written&&q&&written!==q)throw Error('O ID e a mensagem respondida não correspondem.');const op=this.s.operations.find(o=>o.id===(written||q));if(!op)throw Error('Responda à operação ou informe o ID completo. OK solto não confirma nada.');return op;}
 status(op){if(['CONFIRMADO','CANCELADO'].includes(op.status))return;if(op.flags.length)op.status='BLOQUEADO';else if(!op.approval)op.status='AGUARDANDO_FINANCEIRO';else if(!op.proof)op.status='AGUARDANDO_COMPROVANTE';else if(!op.account&&op.type!=='TRANSFERENCIA')op.status='AGUARDANDO_CONTA';else {op.status='CONFIRMADO';op.confirmedAt=this.now().toISOString();op.cashDate=this.today();}}
 view(o){return `ID: ${o.id}${NL}RP: ${o.rp}${NL}${o.type}: ${o.client||o.description}${NL}Valor: ${brl(o.value)}${NL}Status: ${o.status}${NL}${o.flags.length?'Alertas: '+o.flags.join('; ')+(NL):''}Try: NÃO VERIFICADO. Banco: NÃO CONSULTADO.${NL}Somente simulação; não autoriza Pix.`;}
 handle(e){const p=this.queue.then(()=>this._handle(e));this.queue=p.catch(()=>{});return p;}
 async _handle(e){if(!e.id||!e.actor||!e.group)throw Error('Origem inválida.');const k=`${e.group}|${e.id}`;if(this.s.messages[k])return null;const before=structuredClone(this.s);let r;try{r=await this.execute(e);}catch(error){this.s=before;r={text:`⚠️ ${error.message}`};}this.s.messages[k]={actor:e.actor,operation:r?.operation||null,at:this.now().toISOString()};try{await this.save();}catch(error){this.s=before;throw error;}return r;}
}
Object.assign(Engine.prototype, { execute, operation, agenda, account, accounts, summary, help });
