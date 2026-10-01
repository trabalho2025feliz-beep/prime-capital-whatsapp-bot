/** Explicit, phone-scoped sandbox. Never grants live financial permission. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Engine, norm } from './prime-test-runtime.mjs';
import { LiveEngine, LIVE_VERSION } from './prime-live.mjs';
const NL = String.fromCharCode(10);
export const RELEASE = 'PRIME-ASSISTIDA-20261001-2';
export const TEST_RELEASE = 'PRIME-TESTE-ISOLADO-20261001-1';
const TEST_FILE = 'prime-sandbox-v1.json';
export function testBody(text) {
 const value = String(text || '').trim();
 if (value.slice(0,6).toLowerCase() !== '/teste') return null;
 if (value.length > 6 && ![' ',NL,String.fromCharCode(13)].includes(value[6])) return null;
 return value.slice(6).trim() || 'STATUS';
}
export class SandboxEngine extends Engine {
 constructor(file, now, phone, groups) {
  super(null,now);
  if(file && path.basename(file) !== TEST_FILE) throw Error('Sandbox path rejected.');
  if(!/^55[0-9]{10,11}$/.test(phone)) throw Error('Sandbox phone rejected.');
  this.file=file; this.phone=phone; this.groups=structuredClone(groups);
  this.s={...this.s, scope:'ISOLATED_V1', tester:phone, groups:this.groups, closed:true, expiresAt:null};
 }
 async initialize() {
  if(!this.file)return;
  await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
  try {
   const s=JSON.parse(await fs.readFile(this.file,'utf8'));
   if(s.schema!==3||s.mode!=='TEST'||s.scope!=='ISOLATED_V1'||s.tester!==this.phone||JSON.stringify(s.groups)!==JSON.stringify(this.groups)||!Array.isArray(s.operations)) throw Error('Sandbox state rejected.');
   this.s=s;
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  await this.save();
 }
 active() {return !this.s.closed && this.s.expiresAt && Date.parse(this.s.expiresAt)>this.now().getTime();}
 require(e) {if(e.phone!==this.phone)throw Error('Somente o numero cadastrado para testes pode executar esta etapa.');}
 privileged(e) {return e.phone===this.phone;}
 async execute(e) {
  this.require(e);
  if(this.s.groups[e.group]!==e.role)throw Error('Grupo fora do teste.');
  const n=norm(e.text).replace(/^[/]/,'');
  if(['STATUS','DIAGNOSTICO'].includes(n)) return {text:TEST_RELEASE+NL+'Financeiro de testes: RECONHECIDO'+NL+'Sessao: '+(this.active()?'ATIVA':'ENCERRADA')+NL+'Financeiro real e caixa operacional nao alterados. Use /teste iniciar e /teste ajuda.'};
  if(['INICIAR','INICIAR TESTES','MODO TESTE'].includes(n)) {
   this.s.closed=false;this.s.expiresAt=new Date(this.now().getTime()+12*60*60*1000).toISOString();
   this.event(e,'ISOLATED_TEST_OPEN');
   return {text:'TESTES ISOLADOS ATIVOS por ate 12 horas. Use /teste antes de cada mensagem. Nao faca Pix. /teste encerrar fecha apenas esta sessao.'};
  }
  if(['ENCERRAR','FINALIZAR TESTES'].includes(n)) {this.s.closed=true;this.event(e,'ISOLATED_TEST_CLOSE');return {text:'Testes encerrados. Historico preservado. O financeiro da equipe continua sendo o unico financeiro real.'};}
  if(['AJUDA','COMANDOS'].includes(n)) return {text:'Envie /teste na primeira linha, seguido do modelo deste grupo.'+NL+'Confirmacoes: /teste CONFERIDO ID ou responda a uma operacao de teste. Evidencia ficticia: /teste COMPROVANTE SIMULADO ID.'+NL+'Use apenas nomes, chaves e valores ficticios. Anexos nao sao aceitos nesta rodada isolada.'+NL+'No grupo ATUALIZACOES: /teste automatico executa verificacoes internas; /teste saldos consulta somente os saldos ficticios.'+NL+super.help(e.role)};
  if(!this.active())throw Error('Teste encerrado ou expirado. Envie /teste iniciar.');
  if(n.startsWith('AUTORIZAR ')||n==='REVOGAR ACESSO')throw Error('Permissoes de teste fixadas ao numero cadastrado, sem alteracao do financeiro real.');
  if(e.proof)throw Error('Anexos bloqueados no sandbox. Use COMPROVANTE SIMULADO.');
  if(n==='AUTOMATICO') {
   if(e.role!=='report')throw Error('Envie /teste automatico em PRIME | ATUALIZACOES.');
   const count=await checkSandboxRules();
   this.event(e,'INTERNAL_RULE_CHECKS',null,{passed:count});
   return {text:count+' verificacoes internas aprovadas em memoria separada. Nenhum valor criado no caixa real ou no seu caixa de testes. Este resultado nao valida entrega entre contatos, leitura de fotos, Try ou banco.'};
  }
  return super.execute(e);
 }
}
export class DualEngine extends LiveEngine {
 constructor(file, now=()=>new Date(), config=process.env) {
  super(file,now,config);
  this.tester=String(config.PRIME_SANDBOX_PHONE||'').replace(/[^0-9]/g,'');
  this.sandbox=null;
  if(this.tester && this.tester!==this.finance) this.sandbox=new SandboxEngine(file?path.join(path.dirname(file),TEST_FILE):null,now,this.tester,this.configGroups);
 }
 async initialize() {
  await super.initialize();
  if(this.sandbox)try{await this.sandbox.initialize();console.log('[prime-sandbox] READY '+TEST_RELEASE+' separate=true');}catch{this.sandbox=null;console.error('[prime-sandbox] DISABLED invalid_state');}
 }
 testReply(e) {
  if(!e.quoteId||!this.sandbox)return false;
  const key=e.group+'|'+e.quoteId;
  return !!this.sandbox.s.messages[key]?.operation || String(this.s.outbound[key]?.operation||'').startsWith('TESTE-PRIME-');
 }
 target(e) {
  if(testBody(e.text)!==null||this.testReply(e)) throw Error('Anexos de teste nao sao enviados ao caixa real. Use /teste COMPROVANTE SIMULADO ID.');
  return super.target(e);
 }
 async handle(e) {
  const body=testBody(e.text), reply=this.testReply(e);
  if(body!==null||reply) {
   const prefix='TESTE ISOLADO - NAO E DINHEIRO REAL'+NL;
   if(!this.sandbox)return {text:prefix+'Sandbox indisponivel. Nao envie lancamentos ficticios sem /teste.'};
   if(e.phone!==this.tester)return {text:prefix+'Numero nao autorizado para testes. Nenhuma permissao real foi alterada.'};
   if(e.quoteId) {
    const key=e.group+'|'+e.quoteId, operation=this.s.outbound[key]?.operation;
    if(String(operation||'').startsWith('TESTE-PRIME-'))this.sandbox.s.outbound[key]={operation};
   }
   const result=await this.sandbox.handle({...e,text:body===null?e.text:body});
   return result?.text?{...result,text:prefix+result.text}:result;
  }
  const n=norm(e.text).replace(/^[/]/,'');
  const read=/^(STATUS|AJUDA|COMANDOS|DIAGNOSTICO|ATUALIZA|RESUMO|SALDOS|CONCILIACAO|PENDEN|PAINEL|O QUE|MOVIMENTACOES|AUDITORIA|CONSULTAR)/.test(n);
  if(e.phone===this.tester&&this.sandbox?.active()&&!read)return {text:'Seu teste esta ativo. Use /teste antes do lancamento ou /teste encerrar. Nada foi registrado no caixa real.'};
  const result=await super.handle(e);
  if(result?.text)result.text=result.text.replaceAll(LIVE_VERSION,RELEASE);
  return result;
 }
}
export async function checkSandboxRules() {
 const assert=(await import('node:assert/strict')).default;
 const groups={'1@g.us':'incoming','2@g.us':'outgoing','3@g.us':'agenda','4@g.us':'report'};
 const config={PRIME_FINANCE_PHONE:'551100000000',PRIME_SANDBOX_PHONE:'5511999999999',PRIME_GROUPS_JSON:JSON.stringify(groups)};
 const engine=new DualEngine(null,()=>new Date('2026-10-01T12:00:00Z'),config);
 let id=0, count=0;
 const call=async(role,text,phone=config.PRIME_SANDBOX_PHONE,extra={})=>engine.handle({id:String(++id),group:Object.keys(groups).find(g=>groups[g]===role),role,actor:phone,phone,owner:true,admin:true,text,...extra});
 const ok=value=>{assert.ok(value);count++;};
 const liveBefore=JSON.stringify(engine.s);
 await call('report','/teste iniciar');ok(engine.sandbox.active());
 ok((await call('report','/teste status')).text.includes('RECONHECIDO'));
 await call('report','/teste'+NL+'ABERTURA DE CONTA'+NL+'Conta: FICTICIA'+NL+'Saldo inicial: 1000,00');
 for(const rp of ['RP1','RP2','RP3','RP4','RP5']) {
  const result=await call('incoming','/teste'+NL+'ENTRADA'+NL+'RP: '+rp+NL+'Cliente: FICTICIO'+NL+'Codigo: F-'+rp+NL+'Valor: 100,00'+NL+'Referente a: Juros'+NL+'Conta: FICTICIA');
  const op=result.operation;
  ok(!!op&&op.startsWith('TESTE-PRIME-'));
  await call('incoming','/teste COMPROVANTE SIMULADO '+op);
  await call('incoming','/teste CONFERIDO '+op);
  ok(engine.sandbox.s.operations.find(o=>o.id===op).status==='CONFIRMADO');
 }
 const sale=await call('outgoing','/teste'+NL+'VENDA'+NL+'RP: RP1'+NL+'Codigo: S1'+NL+'Tipo: Nova'+NL+'Nome: FICTICIO'+NL+'Pix: NAO-PAGAR'+NL+'Banco: FICTICIO'+NL+'Valor: 190,00'+NL+'Conta: FICTICIA');
 await call('outgoing','/teste COMPROVANTE SIMULADO '+sale.operation);
 await call('outgoing','/teste OK '+sale.operation);
 ok(engine.sandbox.s.operations.at(-1).status==='CONFIRMADO');
 ok(engine.sandbox.accounts().includes('1.310,00'));
 ok(JSON.stringify(engine.s)===liveBefore);
 const testBefore=JSON.stringify(engine.sandbox.s);
 await call('incoming','/teste CONFERIDO '+sale.operation,config.PRIME_FINANCE_PHONE);
 ok(JSON.stringify(engine.sandbox.s)===testBefore);
 await call('report','CONFERIDO');ok(JSON.stringify(engine.s)===liveBefore);
 await call('report','INICIAR OPERACAO',config.PRIME_SANDBOX_PHONE);ok(engine.s.phase==='READY');
 await call('report','INICIAR OPERACAO',config.PRIME_FINANCE_PHONE);ok(engine.s.phase==='ACTIVE');
 await call('report','/teste encerrar');ok(!engine.sandbox.active());
 ok(engine.finance===config.PRIME_FINANCE_PHONE);
 ok(testBody('/testex')===null && testBody('/teste STATUS')==='STATUS');
 const temp=await fs.mkdtemp('/tmp/prime-sandbox-check-');
 try {
  const location=path.join(temp,'prime-live-v1.json');
  const first=new DualEngine(location,engine.now,config);await first.initialize();
  first.s.accounts.push({name:'LIVE_FIXTURE',key:'LIVE_FIXTURE',date:'2026-10-01',opening:32991});await first.save();
  const original=await fs.readFile(location,'utf8');
  await first.handle({id:'p1',group:'4@g.us',role:'report',actor:'tester',phone:config.PRIME_SANDBOX_PHONE,text:'/teste iniciar'});
  await first.handle({id:'p2',group:'4@g.us',role:'report',actor:'tester',phone:config.PRIME_SANDBOX_PHONE,text:'/teste'+NL+'ABERTURA DE CONTA'+NL+'Conta: FAKE'+NL+'Saldo inicial: 1000,00'});
  ok((await fs.readFile(location,'utf8'))===original);
  const second=new DualEngine(location,engine.now,config);await second.initialize();
  ok(second.s.accounts[0].opening===32991 && second.sandbox.s.accounts[0].opening===100000);
  ok((await fs.stat(path.join(temp,TEST_FILE))).mode%512===384);
 } finally {await fs.rm(temp,{recursive:true,force:true});}
 return count;
}
if(process.argv.includes('--sandbox-self-test'))console.log('SANDBOX_CHECKS_PASS '+await checkSandboxRules());
