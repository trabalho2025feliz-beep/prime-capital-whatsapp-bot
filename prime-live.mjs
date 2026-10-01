/** Assisted operation. No bank/payment API; test data and test roles are never loaded. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Engine, norm, amount, fields } from './prime-test-runtime.mjs';
export const LIVE_VERSION = 'PRIME-ASSISTIDA-20261001-1';
const NL = String.fromCharCode(10);
const digest = s => createHash('sha256').update(s).digest('hex');
export const phoneOf = jid => {
 const s = String(jid || '');
 return s.endsWith('@s.whatsapp.net') ? s.split('@')[0].split(':')[0] : '';
};
export function verifiedPhone(message, meta, ownId) {
 const actor = message.key.fromMe ? ownId : message.key.participant || message.participant;
 const clean = v => String(v || '').replace(/:[0-9]+(?=@)/, '');
 const ids = p => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(clean);
 const member = (meta.participants || []).find(p => ids(p).includes(clean(actor)));
 const direct = phoneOf(actor);
 if (direct) return direct;
 const values = member ? ids(member).map(phoneOf).filter(Boolean) : [];
 const unique = [...new Set(values)];
 return unique.length === 1 ? unique[0] : '';
}
export class LiveEngine extends Engine {
 constructor(file='/data/prime-live-v1.json', now=()=>new Date(), config=process.env) {
  super(null, now);
  if (file && path.basename(file) !== 'prime-live-v1.json') throw Error('Arquivo operacional incorreto.');
  this.file = file;
  this.finance = String(config.PRIME_FINANCE_PHONE || '').replace(/[^0-9]/g, '');
  if (!/^55[0-9]{10,11}$/.test(this.finance)) throw Error('Financeiro unico nao configurado.');
  const groups = JSON.parse(config.PRIME_GROUPS_JSON || '{}');
  const roles = ['incoming','outgoing','agenda','report'];
  if (Object.keys(groups).length !== 4 || roles.some(r => !Object.values(groups).includes(r)) || Object.keys(groups).some(k => !/^[0-9]+@g[.]us$/.test(k))) throw Error('Os quatro grupos precisam estar identificados.');
  this.configGroups = groups;
  this.s = {...this.s, schema:4, mode:'LIVE', phase:'READY', openedAt:null, finance:this.finance, groups, roles:{}};
 }
 async initialize() {
  if (!this.file) return;
  await fs.mkdir(path.dirname(this.file), {recursive:true, mode:0o700});
  try {
   const s = JSON.parse(await fs.readFile(this.file,'utf8'));
   if (s.schema !== 4 || s.mode !== 'LIVE' || !Array.isArray(s.operations) || !Array.isArray(s.events) || !s.messages || !s.outbound) throw Error('Base operacional invalida; nada foi sobrescrito.');
   if (s.finance !== this.finance || JSON.stringify(s.groups) !== JSON.stringify(this.configGroups)) throw Error('Mudanca de financeiro/grupos exige revisao; ativacao bloqueada.');
   this.s = s;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await this.save();
 }
 async save() {
  if (!this.file) return;
  try { await fs.copyFile(this.file, this.file+'.bak'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  await super.save();
 }
 isFinance(e) { return !!e.phone && e.phone === this.finance; }
 privileged(e) { return this.isFinance(e); }
 require(e, roles=['FINANCEIRO']) {
  if (this.isFinance(e)) return;
  if (roles.includes('SOCIO') && e.role === 'report' && (e.owner || e.admin || this.s.roles[e.actor] === 'SOCIO')) return;
  throw Error('Somente o financeiro cadastrado pode confirmar ou alterar valores. Nome de contato e cargo de administrador nao concedem essa permissao.');
 }
 id(rp) { return super.id(rp).replace('TESTE-',''); }
 target(e) {
  const written = String(e.text).match(/(?:^|[^A-Z0-9-])(PRIME-[0-9]{6}-(?:RP[1-5]|ADM)-[0-9]{4,})(?![A-Z0-9-])/i)?.[1]?.toUpperCase();
  if (String(e.text).includes('TESTE-PRIME-')) throw Error('ID de teste nao pode ser usado na operacao.');
  const q = e.quoteId && (this.s.messages[`${e.group}|${e.quoteId}`]?.operation || this.s.outbound[`${e.group}|${e.quoteId}`]?.operation);
  if (written && q && written !== q) throw Error('ID e mensagem respondida nao correspondem.');
  const o = this.s.operations.find(o => o.id === (written || q));
  if (!o) throw Error('Responda a operacao original ou informe o ID completo.');
  return o;
 }
 event(e, action, op, detail={}) { super.event(e, action.replace(/_TEST$/, '_LIVE'), op, detail); }
 status(o) {
  if (!['CONFIRMADO','CANCELADO'].includes(o.status) && o.approval && o.proof && !o.flags.length) {
   const needed = o.type === 'TRANSFERENCIA' ? [o.from,o.to] : [o.account];
   if (needed.some(a => !a || !this.s.accounts.some(x => x.key === norm(a) && x.date === this.today()))) {o.status='AGUARDANDO_ABERTURA';return;}
   if (o.proof.simulated) {o.status='BLOQUEADO';return;}
  }
  super.status(o);
 }
 view(o) {
  return [`ID: ${o.id}`,'RP: '+o.rp,`${o.type}: ${o.client || o.description}`,'Valor: '+new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(o.value/100),`Status: ${o.status}`,o.flags.length ? 'Pendencias: '+o.flags.join('; ') : '', 'Confirmacao humana do financeiro. Try e banco nao consultados pelo bot.'].filter(Boolean).join(NL);
 }
 summary(q='') {
  if (/SEMANA|MES PASSADO/.test(norm(q))) throw Error('Informe o periodo com datas DD/MM/AAAA para evitar consulta ambigua.');
  return ('Inicio da operacao: '+(this.s.openedAt || 'nao iniciado')+NL+super.summary(q)).replace('Tudo é TESTE. Não representa lucro. Try/banco não verificados.', 'Operacao assistida. Caixa nao e lucro. Try/banco nao verificados.');
 }
 accounts(day=this.today()) { return super.accounts(day).replace('CONTAS DE TESTE', 'CONTAS DA OPERACAO ASSISTIDA'); }
 help() {
  return ['STATUS | AJUDA | DIAGNOSTICO','No grupo ATUALIZACOES, somente o financeiro cadastrado:','INICIAR OPERACAO | PAUSAR OPERACAO','ABERTURA DE CONTA / FECHAMENTO DE CONTA (CONTA e saldo)','Consultas: ATUALIZACAO RP1, ATUALIZACAO PRIME, SALDOS, PENDENCIAS, CONSULTAR ID','Entradas: ENTRADA, RP, CLIENTE, CODIGO/CONTRATO, VALOR, REFERENTE A, CONTA QUE RECEBEU.','Saidas: VENDA, RP, CODIGO, TIPO, NOME, PIX, BANCO, VALOR, CONTA DE ORIGEM.','Despesas: SAIDA, RP/SETOR, TIPO, DESCRICAO, VALOR, CONTA.','Agenda: AGENDA, RP; para cada item CLIENTE, CODIGO/CONTRATO, VALOR PREVISTO.','Envie cada campo em sua propria linha, seguido de dois-pontos.','Anexe o comprovante respondendo a operacao. O financeiro responde CONFERIDO ou OK na mesma operacao somente depois de conferir no banco.','Comprovante nao lido: financeiro responde VALIDAR COMPROVANTE, VALOR, ID DA TRANSACAO, SITUACAO: CONCLUIDO e MOTIVO.','Nao ha comprovante simulado nesta base. Nao envie testes financeiros.'].join(NL);
 }
 async execute(e) {
  if (this.s.groups[e.group] !== e.role) throw Error('Grupo nao autorizado.');
  const n = norm(e.text).replace(/^[/]/,''), f = fields(e.text);
  if (['STATUS','DIAGNOSTICO'].includes(n)) return {text:[LIVE_VERSION, 'Estado: '+this.s.phase, 'Financeiro neste envio: '+(this.isFinance(e)?'RECONHECIDO':e.phone?'OUTRO NUMERO':'TELEFONE NAO RESOLVIDO'), 'Grupos configurados: 4. Confirmacao financeira exclusiva para o numero cadastrado.', 'Inicio: '+(this.s.openedAt || 'pendente'), 'Base operacional separada. Try/banco nao integrados.'].join(NL)};
  if (['AJUDA','COMANDOS'].includes(n)) return {text:this.help()};
  if (/^(MODO TESTE|INICIAR TESTES|FINALIZAR TESTES|COMPROVANTE SIMULADO)/.test(n) || n.includes('TESTE-PRIME-')) throw Error('Comando de teste bloqueado nesta base. Nenhuma simulacao sera contabilizada.');
  if (n === 'INICIAR OPERACAO' || n === 'PAUSAR OPERACAO') {
   this.require(e);
   if (e.role !== 'report') throw Error('Use o grupo PRIME | ATUALIZACOES.');
   this.s.phase = n.startsWith('INICIAR') ? 'ACTIVE' : 'PAUSED';
   if (this.s.phase === 'ACTIVE' && !this.s.openedAt) this.s.openedAt = this.now().toISOString();
   this.event(e, 'OPERATION_'+this.s.phase);
   return {text:LIVE_VERSION+NL+'Estado: '+this.s.phase+NL+'Apenas registros enviados a partir da ativacao. Saldos iniciais devem ser informados pelo financeiro. Mantenha Try e banco em paralelo.'};
  }
  if (/^AUTORIZAR FINANCEIRO|^AUTORIZAR REVISOR/.test(n)) throw Error('Financeiro unico definido na configuracao; permissoes de teste nao foram importadas.');
  if (/^AUTORIZAR SOCIO|^REVOGAR ACESSO/.test(n)) {
   this.require(e);
   if(e.role !== 'report') throw Error('Use ATUALIZACOES.');
   const actor = e.quoteId && this.s.messages[`${e.group}|${e.quoteId}`]?.actor;
   if(!actor) throw Error('Responda a uma mensagem recente da pessoa.');
   if(n.startsWith('REVOGAR')) delete this.s.roles[actor]; else this.s.roles[actor]='SOCIO';
   this.event(e,'VIEWER_PERMISSION',null,{target:actor});
   return {text:'Permissao de consulta atualizada. Nao concede confirmacao financeira.'};
  }
  const query = /^(ATUALIZA|RESUMO|SALDOS|CONCILIACAO|PENDEN|PAINEL|O QUE|MOVIMENTACOES|AUDITORIA|CONSULTAR|REVISÃO)/.test(n);
  if (!query && this.s.phase !== 'ACTIVE') throw Error('Operacao ainda nao iniciada ou pausada. O financeiro deve enviar INICIAR OPERACAO em ATUALIZACOES.');
  if (e.proof?.simulated) throw Error('Comprovante simulado bloqueado.');
  const financeAction = /^(OK|CONFERIDO|CONFIRMAR|VALIDAR COMPROVANTE|CORRIGIR|CORRECAO|CANCELAR|ESTORNO|REVISADO|ABERTURA|FECHAMENTO)/.test(n);
  if (financeAction) this.require(e);
  if (/^(OK|CONFERIDO|CONFIRMAR|VALIDAR COMPROVANTE)/.test(n)) {
   const o = this.target(e);
   if (o.group !== e.group) throw Error('Confirme no grupo original da operacao.');
   if (o.status === 'CONFIRMADO') return {text:this.view(o), operation:o.id};
   if (n.startsWith('VALIDAR')) {
    if (!o.proof || o.proof.simulated) throw Error('Anexe o comprovante primeiro.');
    if (['scheduled','cancelled'].includes(o.proof.settlement)) throw Error('Comprovante agendado/cancelado nao pode ser aprovado. Envie evidencia de transacao concluida.');
    if (norm(f.SITUACAO) !== 'CONCLUIDO' || !f['ID DA TRANSACAO'] || 12 > f['ID DA TRANSACAO'].length) throw Error('Informe SITUACAO: CONCLUIDO e ID DA TRANSACAO do comprovante.');
    const tx = digest(norm(f['ID DA TRANSACAO']));
    if (this.s.events.some(x => x.transaction === tx && x.operation !== o.id)) throw Error('Identificador de transacao ja utilizado.');
    if (amount(f.VALOR || f['VALOR DO COMPROVANTE']) !== o.value || !f.MOTIVO) throw Error('Informe valor correto e motivo da verificacao manual.');
    o.proof.transaction = tx;
    this.event(e,'TRANSACTION_VALIDATED',o,{transaction:tx});
   } else {
    const account = o.account || f.CONTA;
    const required = o.type === 'TRANSFERENCIA' ? [o.from,o.to] : [account];
    if (required.some(a => !this.s.accounts.some(x => x.date === this.today() && x.key === norm(a)))) throw Error('Financeiro: registre a abertura das contas envolvidas antes da confirmacao.');
   }
  }
  if (e.proof) {
   const creates = /^(ENTRADA|VENDA|SAIDA|RENOVACAO|RETORNO|APORTE|RETIRADA|TRANSFERENCIA INTERNA)([ :]|$)|^CODIGO *:/.test(n.split(NL)[0]);
   if (!creates) {
    const original = this.target(e);
    if (original.status === 'CONFIRMADO') return {text:this.view(original), operation:original.id};
    if (original.approval) {
     original.approval=null;
     this.event(e,'PROOF_REQUIRES_NEW_APPROVAL',original);
    }
   }
  }
  const r = await super.execute(e);
  if (r?.text) r.text = r.text.replace(/no TESTE/g,'na operacao').replace(/somente para TESTE/gi,'para consulta').replace(/em TESTE/g,'na operacao').replace('Somente teste. Finalizar testes não ativa produção. Validação no WhatsApp e conciliação bancária ainda exigem conferência humana.', 'Operacao assistida. Conferencia bancaria humana obrigatoria.');
  return r;
 }
}

export async function runChecks() {
 const assert=(await import('node:assert/strict')).default;
 const groups={'1@g.us':'incoming','2@g.us':'outgoing','3@g.us':'agenda','4@g.us':'report'};
 const cfg={PRIME_FINANCE_PHONE:'551100000000',PRIME_GROUPS_JSON:JSON.stringify(groups)};
 const e=new LiveEngine(null,()=>new Date('2026-10-01T12:00:00Z'),cfg);
 let seq=0, count=0;
 const send=async(role,text,finance=false,extra={})=>e.handle({id:String(++seq),group:Object.keys(groups).find(g=>groups[g]===role),role,text,actor:finance?'FINANCE':'STAFF',phone:finance?cfg.PRIME_FINANCE_PHONE:'5511999999999',owner:false,admin:false,...extra});
 const ok=(v)=>{assert.ok(v);count++;};
 ok(e.s.phase==='READY' && e.s.operations.length===0 && Object.keys(e.s.roles).length===0);
 await send('report','INICIAR OPERACAO',false,{owner:true,admin:true});ok(e.s.phase==='READY');
 await send('report','INICIAR OPERACAO',true);ok(e.s.phase==='ACTIVE');
 await send('report','ABERTURA DE CONTA'+NL+'Conta: CAIXA'+NL+'Saldo inicial: 1000,00',true);
 const input='ENTRADA'+NL+'RP: RP1'+NL+'Cliente: Cliente A'+NL+'Codigo/Contrato: A1'+NL+'Valor: 100,00'+NL+'Referente a: Juros'+NL+'Conta que recebeu: CAIXA';
 let r=await send('incoming',input);const id=r.operation;ok(id&&id.startsWith('PRIME-')&&e.s.operations[0].status!=='CONFIRMADO');
 await send('incoming','CONFERIDO '+id,false,{owner:true,admin:true});ok(!e.s.operations[0].approval);
 await send('incoming','COMPROVANTE SIMULADO '+id,true);ok(!e.s.operations[0].proof);
 await send('incoming','ANEXO '+id,false,{proof:{hash:'proofA',value:10000,settlement:'completed'}});
 await send('incoming','CONFERIDO '+id,true);ok(e.s.operations[0].status==='CONFIRMADO');
 const duplicate=await send('incoming',input);ok(e.s.operations[1].status==='BLOQUEADO'&&duplicate.operation!==id);
 await send('outgoing','CONFERIDO '+id,true);ok(e.s.operations[0].status==='CONFIRMADO');
 await send('agenda','AGENDA'+NL+'RP: RP1'+NL+'Cliente: Cliente A'+NL+'Codigo: A1'+NL+'Valor previsto: 150,00');
 ok(e.summary('RP1').includes('50,00'));
 const sale='VENDA'+NL+'RP: RP1'+NL+'Codigo: B1'+NL+'Tipo: Nova'+NL+'Nome: Cliente B'+NL+'Pix: NAO-PAGAR'+NL+'Banco: ficticio'+NL+'Valor: 190,00'+NL+'Conta de origem: CAIXA';
 r=await send('outgoing',sale);const id2=r.operation;
 await send('outgoing','ANEXO '+id2,true,{proof:{hash:'proofB',value:19000,settlement:'completed'}});
 await send('outgoing','OK '+id2,true);ok(e.s.operations.find(o=>o.id===id2).status==='CONFIRMADO');
 ok(e.accounts().includes('910,00'));
 await send('report','AUTORIZAR FINANCEIRO',true);ok(Object.keys(e.s.roles).length===0);
 await send('report','PAUSAR OPERACAO',true);await send('incoming',input.replace('A1','A2'));ok(e.s.operations.length===3&&e.s.phase==='PAUSED');
 const meta={participants:[{id:'123@lid',phoneNumber:'551100000000@s.whatsapp.net'}]};
 ok(verifiedPhone({key:{participant:'123@lid'}},meta,'')==='551100000000');
 ok(verifiedPhone({key:{participant:'456@lid',participantAlt:'551100000000@s.whatsapp.net'}},meta,'')==='');
 console.log('LIVE_SELF_TEST_PASS '+count);
 return count;
}
if (process.argv.includes('--self-test')) await runChecks();
