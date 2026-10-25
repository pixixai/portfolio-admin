import {mkdir,readdir,rename,rm,access,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fail} from './validation.mjs';

export const releaseRetention = store => store.get('releaseRetention') ?? 10;
export function validateRetention(keep) { if(![5,10].includes(keep))fail('请选择保留最近5条或10条发布记录。');return keep; }
const exists=async target=>{try{await access(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function child(root,id) {
  const base=path.resolve(root),target=path.resolve(base,id);
  if(!/^[\w-]{1,100}$/.test(id)||path.dirname(target)!==base)throw new Error('发布记录目录不正确，未执行清理。');
  return target;
}
async function removeOwned(root,id) {
  const target=child(root,id);if(!await exists(target))return;
  const actual=await realpath(target),base=await realpath(root);
  if(path.dirname(actual)!==base)throw new Error('发布记录目录超出清理范围。');
  // rm removes nested symbolic links themselves, without following their targets.
  await rm(target,{recursive:true,force:true});
}
export async function recoverReleaseCleanup(store) {
  const quarantine=path.join(store.directory,'.release-cleanup'),releases=path.join(store.directory,'releases');
  await mkdir(quarantine,{recursive:true});let pending=0;
  const base=await realpath(store.directory);
  if(path.dirname(await realpath(quarantine))!==base||path.dirname(await realpath(releases))!==base)throw new Error('历史目录超出运行数据范围，未执行清理。');
  for(const item of await readdir(quarantine,{withFileTypes:true})){
    if(!item.isDirectory()||!/^\w[\w-]*$/.test(item.name))continue;
    const source=child(quarantine,item.name),target=child(releases,item.name);
    if(store.db.prepare('SELECT id FROM releases WHERE id=?').get(item.name)){
      if(await exists(target))throw new Error('发现重复的待清理版本，已保留文件，请检查。');
      await rename(source,target);
    }else{try{await removeOwned(quarantine,item.name);}catch{pending++;}}
  }
  return pending;
}
export async function pruneReleases(store,keep=releaseRetention(store),persist=false) {
  validateRetention(keep);const deferred=await recoverReleaseCleanup(store);
  const rows=store.releases(),current=store.get('currentRelease'),retained=new Set(rows.slice(0,keep).map(row=>row.id));
  if(current&&!rows.some(row=>row.id===current))throw new Error('当前发布版本不存在，未执行清理。');
  if(current&&!retained.has(current)){if(retained.size>=keep)retained.delete([...retained].at(-1));retained.add(current);}
  const obsolete=rows.filter(row=>!retained.has(row.id)),releases=path.join(store.directory,'releases'),quarantine=path.join(store.directory,'.release-cleanup'),moved=[];
  try{
    for(const row of obsolete){const source=child(releases,row.id),target=child(quarantine,row.id);if(await exists(source)){await rename(source,target);moved.push(row.id);}}
    store.transaction(()=>{
      if(obsolete.some(row=>row.id===store.get('currentRelease')))throw new Error('当前版本已变更，已取消清理。');
      for(const row of obsolete)store.db.prepare('DELETE FROM releases WHERE id=?').run(row.id);
      if(persist)store.set('releaseRetention',keep);
    });
  }catch(error){for(const id of moved.reverse())await rename(child(quarantine,id),child(releases,id));throw error;}
  let pending=deferred;for(const id of moved){try{await removeOwned(quarantine,id);}catch{pending++;}}
  return {keep,removed:obsolete.map(row=>row.id),pending};
}
