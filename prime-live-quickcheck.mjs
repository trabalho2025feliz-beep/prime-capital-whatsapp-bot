/** Short commands for explicit sandbox fixtures; never financial approvals in LIVE. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Engine, norm, brl } from './prime-test-runtime.mjs';
import { DualEngine, RELEASE as PREVIOUS_RELEASE } from './prime-live-sandbox.mjs';
export const QUICK_RELEASE = 'PRIME-ASSISTIDA-20261002-3';
const NL = String.fromCharCode(10);
const MARK = 'QA-RAPIDA-V1-';
export async function quickCheck(sandbox,e,kind,rp='RP1') {
 if(sandbox.s.mode!=='TEST'||sandbox.s.scope!=='ISOLATED_V1')throw Error('Teste rapido exige base isolada.');
 sandbox.require(e);
 if(sandbox.s.groups[e.group]!==e.role)throw Error('Grupo nao autorizado.');
 const role=kind==='ENTRADA'?'incoming':kind==='SAIDA'?'outgoing':null;
 if(!role||!/^RP[1-5]$/.test(rp))throw Error('Tipo ou RP invalido.');
 if(e.role!==role)throw Error('Envie /teste validar '+kind.toLowerCase()+' no grupo PRIME | '+(kind==='ENTRADA'?'ENTRADAS':'SAIDAS')+'.');
 if(e.proof||e.quoteId)throw Error('Envie este comando como texto novo, sem anexo ou resposta a outra operacao.');
 const day=sandbox.today(), code=MARK+day+'-'+rp+'-'+kind;
 const existing=sandbox.s.operations.filter(o=>o.contract===code);
 if(existing.length>1)throw Error('Exercicio duplicado encontrado; revisao necessaria, nada foi somado.');
 let op=existing[0];
 if(op&&(op.status!=='CONFIRMADO'||!op.proof?.simulated||op.value!==(kind==='ENTRADA'?10000:19000)))throw Error('Exercicio anterior inconsistente; revisao necessaria.');
 if(!sandbox.active()) {
  sandbox.s.closed=false;
  sandbox.s.expiresAt=new Date(sandbox.now().getTime()+43200000).toISOString();
  sandbox.event(e,'ISOLATED_TEST_OPEN',null,{trigger:'explicit_quick_test'});
 }
 const wasExisting=!!op;
 const step=async(suffix,text)=>Engine.prototype.execute.call(sandbox,{...e,id:e.id+'-quick-'+suffix,text,proof:undefined,quoteId:undefined});
 if(!op) {
  const lines=kind==='ENTRADA'
   ? ['ENTRADA','RP: '+rp,'Cliente: FICTICIO TESTE RAPIDO','Codigo: '+code,'Valor: 100,00','Referente a: Juros','Conta: CONTA FICTICIA QA RAPIDA']
   : ['VENDA','RP: '+rp,'Codigo: '+code,'Tipo: Nova','Nome: FICTICIO TESTE RAPIDO','Pix: CHAVE-FICTICIA-NAO-PAGAR','Banco: BANCO FICTICIO','Valor: 190,00','Conta: CONTA FICTICIA QA RAPIDA'];
  const created=await step('create',lines.join(NL));
  op=sandbox.s.operations.find(o=>o.id===created?.operation);
  if(!op||!op.id.startsWith('TESTE-PRIME-')||op.status!=='AGUARDANDO_FINANCEIRO')throw Error('Falha no registro isolado.');
  await step('proof','COMPROVANTE SIMULADO '+op.id);
  if(!op.proof?.simulated||op.status==='CONFIRMADO')throw Error('Comprovante simulado nao validado.');
  await step('confirm','CONFERIDO '+op.id);
  if(op.status!=='CONFIRMADO')throw Error('Confirmacao simulada nao concluida.');
 }
 const count=sandbox.s.operations.length, value=op.value;
 await step('repeat','CONFERIDO '+op.id);
 if(sandbox.s.operations.length!==count||op.value!==value||op.status!=='CONFIRMADO')throw Error('Falha na protecao contra repeticao.');
 sandbox.event(e,'QUICK_TEXT_WORKFLOW_PASSED',op,{source:'internal_simulation_from_authorized_command',receipt:'simulated_only',repeat:wasExisting});
 const rows=sandbox.s.operations.filter(o=>o.status==='CONFIRMADO'&&o.date===day&&String(o.contract).startsWith(MARK));
 const sum=type=>rows.filter(o=>o.type===type).reduce((v,o)=>v+o.value,0);
 return {operation:op.id,text:[
  'TESTE RAPIDO DE '+kind+': OK',
  'ID: '+op.id,'RP: '+rp,'Valor ficticio: '+brl(op.value),'Status: '+op.status,
  wasExisting?'Exercicio ja existente reutilizado; nada somado novamente.':'Lancamento e comprovante ficticios registrados apenas nos testes.',
  'Repeticao da confirmacao: sem duplicar.',
  'Totais QA RAPIDA de '+day+': entradas '+brl(sum('RECEBIMENTO_CLIENTE'))+'; saidas '+brl(sum('VENDA_NOVA'))+'.',
  'Caixa real e financeiro real nao alterados. Nenhuma abertura de caixa foi feita.',
  'Este comando simula as etapas internamente. Nao valida foto/PDF, conferencia bancaria, Try ou confirmacao por outro contato.'
 ].join(NL)};
}
export class QuickEngine extends DualEngine {
 constructor(...args) {
  super(...args);
  if(this.sandbox) {
   const sandbox=this.sandbox, prior=sandbox.execute.bind(sandbox);
   sandbox.execute=async function(e) {
    const n=norm(e.text).replace(/^[/]/,''), match=n.match(/^VALIDAR (ENTRADA|SAIDA)(?: (RP[1-5]))?$/);
    if(match)return quickCheck(this,e,match[1],match[2]||'RP1');
    const result=await prior(e);
    if(['AJUDA','COMANDOS'].includes(n)&&result?.text)result.text='Atalhos: /teste validar entrada (ENTRADAS) e /teste validar saida (SAIDAS).'+NL+result.text;
    return result;
   };
  }
 }
 async handle(e) {
  const result=await super.handle(e);
  if(result?.text)result.text=result.text.replaceAll(PREVIOUS_RELEASE,QUICK_RELEASE);
  return result;
 }
}
export async function runQuickChecks() {
 const assert=(await import('node:assert/strict')).default;
 const groups={'1@g.us':'incoming','2@g.us':'outgoing','3@g.us':'agenda','4@g.us':'report'};
 const config={PRIME_FINANCE_PHONE:'551100000000',PRIME_SANDBOX_PHONE:'5511999999999',PRIME_GROUPS_JSON:JSON.stringify(groups)};
 const now=()=>new Date('2026-10-02T12:00:00Z'), engine=new QuickEngine(null,now,config);
 let seq=0,count=0;
 const send=(role,text,extra={})=>engine.handle({id:'q'+(++seq),group:Object.keys(groups).find(k=>groups[k]===role),role,actor:'tester',phone:config.PRIME_SANDBOX_PHONE,text,owner:true,admin:true,...extra});
 const ok=v=>{assert.ok(v);count++;};
 const before=JSON.stringify(engine.s);
 const a=await send('incoming','/teste validar entrada');
 ok(a.text.includes('TESTE RAPIDO DE ENTRADA: OK'));ok(a.operation.startsWith('TESTE-PRIME-'));
 ok(engine.sandbox.s.operations[0].value===10000&&engine.sandbox.s.operations[0].status==='CONFIRMADO');
 const b=await send('outgoing','/teste validar saida');
 ok(b.text.includes('TESTE RAPIDO DE SAIDA: OK'));
 ok(engine.sandbox.s.operations[1].type==='VENDA_NOVA'&&engine.sandbox.s.operations[1].value===19000);
 ok(engine.sandbox.s.operations.every(o=>o.proof.simulated));
 ok(JSON.stringify(engine.s)===before);ok(engine.sandbox.s.accounts.length===0);
 const again=await send('incoming','/teste validar entrada');ok(again.operation===a.operation&&engine.sandbox.s.operations.length===2);
 const snapshot=JSON.stringify(engine.sandbox.s);
 await send('incoming','/teste validar entrada',{phone:config.PRIME_FINANCE_PHONE});ok(JSON.stringify(engine.sandbox.s)===snapshot);
 const wrong=await send('report','/teste validar entrada');ok(wrong.text.includes('no grupo PRIME')&&engine.sandbox.s.operations.length===2);
 const quote=await send('incoming','/teste validar entrada',{quoteId:'other'});ok(quote.text.includes('texto novo'));
 for(const rp of ['RP2','RP3','RP4','RP5']) {await send('incoming','/teste validar entrada '+rp);await send('outgoing','/teste validar saida '+rp);}
 ok(engine.sandbox.s.operations.length===10);ok(new Set(engine.sandbox.s.operations.map(o=>o.id)).size===10);
 ok(engine.sandbox.s.operations.filter(o=>o.direction==='IN').reduce((s,o)=>s+o.value,0)===50000);
 ok(engine.sandbox.s.operations.filter(o=>o.direction==='OUT').reduce((s,o)=>s+o.value,0)===95000);
 ok(JSON.stringify(engine.s)===before);
 await send('report','INICIAR OPERACAO');ok(engine.s.phase==='READY');
 const liveEngine={s:{mode:'LIVE',scope:'ISOLATED_V1'}};
 await assert.rejects(quickCheck(liveEngine,{},'ENTRADA'));count++;
 const dir=await fs.mkdtemp('/tmp/prime-quickcheck-');
 try {
  const file=path.join(dir,'prime-live-v1.json'), disk=new QuickEngine(file,now,config);await disk.initialize();
  const original=await fs.readFile(file,'utf8');
  const e={id:'disk1',group:'1@g.us',role:'incoming',actor:'tester',phone:config.PRIME_SANDBOX_PHONE,text:'/teste validar entrada'};
  await disk.handle(e);ok((await fs.readFile(file,'utf8'))===original);
  const reopened=new QuickEngine(file,now,config);await reopened.initialize();
  ok(reopened.sandbox.s.operations.length===1&&reopened.sandbox.s.operations[0].status==='CONFIRMADO');
  await reopened.handle({...e,id:'disk2'});ok(reopened.sandbox.s.operations.length===1);
  const diskBefore=JSON.stringify(reopened.sandbox.s);reopened.sandbox.save=async()=>{throw Error('disk-failure');};
  await assert.rejects(reopened.handle({...e,id:'disk3',group:'2@g.us',role:'outgoing',text:'/teste validar saida'}));
  ok(JSON.stringify(reopened.sandbox.s)===diskBefore);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
 console.log('QUICK_TEXT_CHECKS_PASS '+count);return count;
}
if(process.argv.includes('--quickcheck-self-test'))await runQuickChecks();
