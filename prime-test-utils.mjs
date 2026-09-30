import { createHash } from 'node:crypto';
export const NL = String.fromCharCode(10);
export const VERSION = 'PRIME-TESTE-20260930-3';
export const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
export const brl = n => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
export const dateKey = d => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
export function amount(v) {
  let s=String(v??'').replace(/R\$/gi,'').replace(/\s/g,'');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s=s.replace(/\./g,'');
  if (!/^\d+([,.]\d{1,2})?$/.test(s)) throw Error('Valor inválido. Use 190,00.');
  const [a,b='']=s.replace(',','.').split('.'); const n=Number(a)*100+Number(b.padEnd(2,'0'));
  if (!Number.isSafeInteger(n)||n>1e11) throw Error('Valor fora do limite.'); return n;
}
export function date(v, fallback) {
  if(!v) return fallback;
  let s=String(v).trim(); const m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if(m)s=`${m[3]}-${m[2]}-${m[1]}`;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error('Data inválida. Use DD/MM/AAAA.');return s;
}
export function fields(text){const f={};for(const l of String(text).split(NL)){const i=l.indexOf(':');if(i>0)f[norm(l.slice(0,i))]=l.slice(i+1).trim();}return f;}
export const get=(f,...ks)=>ks.map(k=>f[k]).find(Boolean)||'';
export const rpOf=t=>String(t).match(/\bRP\s*([1-5])\b/i)?.[1];
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const fresh=()=>({schema:3,mode:'TEST',sequence:{},operations:[],agendas:[],accounts:[],roles:{},groups:{},messages:{},outbound:{},events:[],schedules:{}});
export function selectGroup(groups,names){
 for(const name of [...new Set(names.filter(Boolean))]){
  const matches=groups.filter(g=>norm(g.subject)===norm(name));
  if(matches.length>1)return null;
  if(matches.length===1)return matches[0].id;
 }
 return null;
}
