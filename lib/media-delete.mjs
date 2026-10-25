import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { fail } from './validation.mjs';
import { folders } from './media-folders.mjs';

export function mediaDeletePlan(store,input){
  if(!input||!Array.isArray(input.items)||!input.items.length||input.items.length>500)fail('请选择1～500个项目。');
  const allFolders=folders(store),folderIds=new Set(),assetIds=new Set();
  const visit=id=>{if(folderIds.has(id))return;const row=allFolders.find(row=>row.id===id);if(!row)fail('部分文件夹不存在，请刷新。',404);folderIds.add(id);allFolders.filter(row=>row.parentId===id).forEach(row=>visit(row.id));};
  for(const item of input.items){
    if(item?.kind==='folder')visit(item.id);
    else if(item?.kind==='asset'&&typeof item.id==='string'){if(!store.asset(item.id))fail('部分素材不存在，请刷新。',404);assetIds.add(item.id);}
    else fail('所选项目无效。');
  }
  store.media().filter(asset=>folderIds.has(asset.folderId)).forEach(asset=>assetIds.add(asset.id));
  const assets=[...assetIds].map(id=>store.asset(id)),blocked=assets.filter(asset=>{const refs=store.references(asset.id);return refs.projects.length||refs.inHistory||refs.inSettings;}).map(asset=>({id:asset.id,name:asset.name}));
  return {assetIds:[...assetIds],folderIds:[...folderIds],assets,blocked,mediaCount:assets.length,folderCount:folderIds.size,allowed:!blocked.length};
}
export async function deleteMediaItems(store,input){
  let plan;
  store.transaction(()=>{
    plan=mediaDeletePlan(store,input);
    if(!plan.allowed)fail(`${plan.blocked.length} 项素材被作品、首页设置或历史版本引用，无法删除。所有选中项目均已保留。`,409);
    const pending=store.db.prepare('DELETE FROM pending_media WHERE assetId=?'),media=store.db.prepare('DELETE FROM media WHERE id=?'),folder=store.db.prepare('DELETE FROM media_folders WHERE id=?');
    plan.assetIds.forEach(id=>{pending.run(id);media.run(id);});
    const map=new Map(folders(store).map(row=>[row.id,row])),depth=id=>{let value=0;while(map.get(id)?.parentId){value++;id=map.get(id).parentId;}return value;};
    [...plan.folderIds].sort((a,b)=>depth(b)-depth(a)).forEach(id=>folder.run(id));
  });
  let cleanupPending=0;
  for(const asset of plan.assets){try{await unlink(path.join(store.directory,'uploads',asset.file));}catch(error){if(error.code!=='ENOENT')cleanupPending++;}}
  return {ok:true,mediaCount:plan.mediaCount,folderCount:plan.folderCount,cleanupPending};
}
