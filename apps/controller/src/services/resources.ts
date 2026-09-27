import os from 'node:os';
import { execFileSync } from 'node:child_process';
export function availableMemory():number {
  if (process.platform !== 'darwin') return os.freemem();
  // os.freemem excludes reclaimable inactive pages on macOS.
  const output=execFileSync('/usr/bin/vm_stat',{encoding:'utf8'});
  const page=Number(output.match(/page size of (\d+)/)?.[1] ?? 16384);
  return ['free','inactive','speculative'].reduce((n,k)=>n+Number(output.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1]??0),0)*page;
}
export function assertMemory() { if(availableMemory()<4*1024**3) throw new Error('Less than 4 GiB memory headroom. Work is saved; free memory before retrying.'); }
