/** Startup wrapper: backup /data, archive the isolated test base when the test number changes, then start the bot. */
import fs from 'node:fs/promises';
import path from 'node:path';
const ROOT = process.env.PRIME_DATA_DIR || '/data';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
try {
 const dir = path.join(ROOT, 'backups'), target = path.join(dir, stamp);
 await fs.mkdir(target, {recursive: true, mode: 0o700});
 let n = 0;
 for (const e of await fs.readdir(ROOT, {withFileTypes: true})) {
  if (['backups', 'lost+found', 'prime-live-receipts'].includes(e.name)) continue;
  await fs.cp(path.join(ROOT, e.name), path.join(target, e.name), {recursive: true, force: true});
  n++;
 }
 const all = (await fs.readdir(dir)).filter(x => /^\d{4}-/.test(x)).sort();
 for (const old of all.slice(0, Math.max(0, all.length - 15))) await fs.rm(path.join(dir, old), {recursive: true, force: true});
 console.log('[prime-live] BACKUP_OK entries=' + n + ' kept=' + Math.min(all.length, 15));
} catch (e) { console.error('[prime-live] BACKUP_FAILED ' + String(e && (e.code || e.name) || 'ERROR').slice(0, 30)); }
try {
 const file = path.join(ROOT, 'prime-sandbox-v1.json');
 const tester = String(process.env.PRIME_SANDBOX_PHONE || '').replace(/[^0-9]/g, '');
 const prev = JSON.parse(await fs.readFile(file, 'utf8'));
 if (tester && prev && prev.mode === 'TEST' && prev.scope === 'ISOLATED_V1' && prev.tester !== tester) {
  await fs.rename(file, file + '.archived-' + stamp + '-' + String(prev.tester || '').slice(-4));
  console.log('[prime-sandbox] TESTER_CHANGED previous_archived=true');
 }
} catch (e) { if (e && e.code !== 'ENOENT') console.error('[prime-sandbox] TESTER_CHECK_FAILED ' + String(e.code || e.name || 'ERROR').slice(0, 30)); }
if (!process.env.PRIME_STARTUP_DRY_RUN) await import('./start-live.mjs');
