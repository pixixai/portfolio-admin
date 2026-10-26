import {readdir,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
const valid=/^v-\d+-[a-f0-9]{8}$/;
export async function pruneSidebarPreviews(store,clientId,keepId=null){
  const root=path.join(store.directory,'previews'),base=await realpath(root),rows=[];
  if(path.dirname(base)!==await realpath(store.directory))throw new Error('预览目录超出数据范围。');
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!valid.test(entry.name))continue;
    const directory=path.join(root,entry.name);if(path.dirname(await realpath(directory))!==base)throw new Error('预览清理目录不正确。');
    let meta;try{meta=JSON.parse(await readFile(path.join(directory,'sidebar-preview.json'),'utf8'));}catch{continue;}
    if(typeof meta.clientId==='string'&&Number.isFinite(Date.parse(meta.createdAt)))rows.push({id:entry.name,directory,clientId:meta.clientId,createdAt:meta.createdAt});
  }
  const retained=new Set(rows.filter(row=>row.clientId===clientId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,2).map(row=>row.id));if(valid.test(keepId||''))retained.add(keepId);
  const removed=[];
  for(const row of rows){
    if(row.clientId===clientId?!retained.has(row.id):Date.parse(row.createdAt)<Date.now()-86400000){await rm(row.directory,{recursive:true,force:true});removed.push(row.id);}
  }return removed;
}
