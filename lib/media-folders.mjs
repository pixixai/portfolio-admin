import { randomUUID } from 'node:crypto';
import { fail } from './validation.mjs';
import { now } from './store.mjs';

export function folders(store) { return store.db.prepare('SELECT * FROM media_folders ORDER BY sortOrder,id').all(); }
export function validFolder(store, id) {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id !== 'string' || !store.db.prepare('SELECT id FROM media_folders WHERE id=?').get(id)) fail('文件夹不存在。', 404);
  return id;
}
function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\\/\x00-\x1f]/.test(name) || ['.', '..'].includes(name.trim())) fail('文件夹名称需要1～100个字符，不能包含路径分隔符。');
  return name.trim();
}
export function createFolder(store, name, parentId = null, reuse = false) {
  name = validName(name); parentId = validFolder(store, parentId);
  const existing = store.db.prepare('SELECT * FROM media_folders WHERE parentId IS ? AND name=?').get(parentId, name);
  if (existing) { if (reuse) return existing; fail('当前文件夹内已存在同名文件夹。', 409); }
  const id = randomUUID(), sortOrder = store.db.prepare('SELECT COALESCE(MIN(sortOrder),0)-1 AS value FROM media_folders WHERE parentId IS ?').get(parentId).value;
  store.db.prepare('INSERT INTO media_folders VALUES(?,?,?,?,?)').run(id, name, parentId, now(), sortOrder);
  return store.db.prepare('SELECT * FROM media_folders WHERE id=?').get(id);
}
export function ensureFolderPath(store, parentId, segments) {
  if (!Array.isArray(segments) || segments.length > 20) fail('文件夹层级最多20层。');
  segments.forEach(validName); parentId = validFolder(store, parentId);
  return store.transaction(() => { let folder = parentId ? folders(store).find(row => row.id === parentId) : null; for (const name of segments) { folder = createFolder(store, name, folder?.id || null, true); } return folder; });
}
export function arrangeMedia(store, input) {
  if(!input || typeof input!=='object')fail('移动参数无效。');
  if (input && Array.isArray(input.items)) return arrangeMediaBatch(store, input);
  const table = input.kind === 'asset' ? 'media' : input.kind === 'folder' ? 'media_folders' : null;
  if (!table || typeof input.id !== 'string') fail('请选择要移动的媒体或文件夹。');
  const parentKey = input.kind === 'asset' ? 'folderId' : 'parentId', destination = validFolder(store, input.folderId);
  const source = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(input.id); if (!source) fail('移动的项目不存在。', 404);
  if (input.kind === 'folder') {
    let cursor = destination;
    while (cursor) { if (cursor === input.id) fail('不能将文件夹移入自身或子文件夹。'); cursor = store.db.prepare('SELECT parentId FROM media_folders WHERE id=?').get(cursor).parentId; }
    if (store.db.prepare('SELECT id FROM media_folders WHERE parentId IS ? AND name=? AND id<>?').get(destination, source.name, source.id)) fail('目标位置已有同名文件夹。', 409);
  }
  let target;
  if (input.targetId) {
    target = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(input.targetId);
    if (!target || target[parentKey] !== destination || target.id === source.id) fail('排序目标无效。');
  }
  store.transaction(() => {
    const siblings = store.db.prepare(`SELECT id FROM ${table} WHERE ${parentKey} IS ? AND id<>? ORDER BY sortOrder,id`).all(destination, source.id).map(row => row.id);
    const index = target ? siblings.indexOf(target.id) + (input.after ? 1 : 0) : 0; siblings.splice(index, 0, source.id);
    store.db.prepare(`UPDATE ${table} SET ${parentKey}=? WHERE id=?`).run(destination, source.id);
    const update = store.db.prepare(`UPDATE ${table} SET sortOrder=? WHERE id=?`); siblings.forEach((id, i) => update.run(i + 1, id));
  });
  return { ok: true };
}

function arrangeMediaBatch(store, input) {
  if (!input.items.length || input.items.length > 500) fail('每次请选择1～500个项目。');
  const destination = validFolder(store,input.folderId), seen = new Set();
  let items = input.items.map(item => {
    if (!item || !['asset','folder'].includes(item.kind) || typeof item.id !== 'string') fail('批量移动的项目无效。');
    const key = `${item.kind}:${item.id}`; if(seen.has(key)) fail('不能重复选择同一个项目。');seen.add(key);
    const table = item.kind === 'folder' ? 'media_folders' : 'media', row = store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(item.id);
    if(!row) fail('部分项目已不存在，请刷新。',404);
    return {...item,row};
  });
  const folderMap = new Map(folders(store).map(row=>[row.id,row]));
  const chosenFolders = new Set(items.filter(item=>item.kind==='folder').map(item=>item.id));
  // Selected descendants travel with their selected ancestor rather than being
  // pulled out of it as separate siblings.
  items=items.filter(item=>{let cursor=item.kind==='folder'?item.row.parentId:item.row.folderId;while(cursor){if(chosenFolders.has(cursor))return false;cursor=folderMap.get(cursor)?.parentId;}return true;});
  let cursor=destination;
  while(cursor){if(chosenFolders.has(cursor))fail('不能将文件夹移入自身或子文件夹。');cursor=folderMap.get(cursor)?.parentId;}
  const movingFolders = new Set(items.filter(item=>item.kind==='folder').map(item=>item.id)), names = new Set();
  for(const item of items.filter(item=>item.kind==='folder')) {
    if(names.has(item.row.name)||folders(store).some(row=>row.parentId===destination&&row.name===item.row.name&&!movingFolders.has(row.id)))fail('目标位置或所选项目中存在同名文件夹。',409);
    names.add(item.row.name);
  }
  const targetKind = input.targetKind || input.kind;
  if(input.targetId && (!['folder','asset'].includes(targetKind)||!items.some(item=>item.kind===targetKind)||items.some(item=>item.kind===targetKind&&item.id===input.targetId)))fail('排序目标无效。');
  store.transaction(()=>{
    for(const kind of ['folder','asset']) {
      const moving=items.filter(item=>item.kind===kind);if(!moving.length)continue;
      const table=kind==='folder'?'media_folders':'media',parentKey=kind==='folder'?'parentId':'folderId',ids=moving.map(item=>item.id),idSet=new Set(ids);
      const siblings=store.db.prepare(`SELECT id FROM ${table} WHERE ${parentKey} IS ? ORDER BY sortOrder,id`).all(destination).map(row=>row.id).filter(id=>!idSet.has(id));
      let index=0;
      if(input.targetId&&targetKind===kind){index=siblings.indexOf(input.targetId);if(index<0)fail('排序目标无效。');if(input.after)index++;}
      const arranged=[...siblings.slice(0,index),...ids,...siblings.slice(index)];
      const move=store.db.prepare(`UPDATE ${table} SET ${parentKey}=? WHERE id=?`);ids.forEach(id=>move.run(destination,id));
      const order=store.db.prepare(`UPDATE ${table} SET sortOrder=? WHERE id=?`);arranged.forEach((id,i)=>order.run(i+1,id));
    }
  });
  return {ok:true,moved:items.length};
}
