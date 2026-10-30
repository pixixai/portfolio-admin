import {randomBytes,randomUUID} from 'node:crypto';
import {fail,validateProject} from './validation.mjs';
import {projectLabels,orderLabelGroups} from './labels.mjs';
import {mainSpace,spacesDraft,documentGroups,validateMainSpace,validateSpaces,globalLabelOrder} from './spaces.mjs';
import {now} from './store.mjs';

export const labelOptions=globalLabelOrder;
export function orderedGroupProjects(group,rows){
  return rows.filter(row=>documentGroups(row.draft||row).includes(group.label)||group.projectIds.includes(row.id));
}
function assertProjectRevisions(rows,revisions){if(!Array.isArray(revisions)||revisions.length!==rows.length||new Set(revisions.map(row=>row?.id)).size!==rows.length||rows.some(row=>!revisions.some(item=>item?.id===row.id&&item.revision===row.revision)))fail('作品或排序已在别处修改，请刷新后重试。',409);}
function uniqueName(name,existing,max){for(let i=1;;i++){const suffix=i===1?' · 副本':` · 副本${i}`,candidate=name.slice(0,max-suffix.length)+suffix;if(!existing.includes(candidate))return candidate;}}
function assertRevision(actual,expected){if(actual!==expected)fail('内容已在别处修改，请刷新后重试。',409);}
function arrange(original,input,copyIds=[]){
  const {ids,visibleIds=original,targetId,after=false,copy=false}=input;
  const valid=list=>Array.isArray(list)&&list.length>0&&list.length<=5000&&new Set(list).size===list.length&&list.every(id=>original.includes(id));
  if(!valid(ids)||!valid(visibleIds)||ids.some(id=>!visibleIds.includes(id))||!visibleIds.includes(targetId)||typeof after!=='boolean'||typeof copy!=='boolean')fail('拖拽位置或选择已变化，请刷新后重试。',409);
  const ordered=visibleIds.filter(id=>ids.includes(id));
  if(!copy&&ids.includes(targetId))return original;
  const remaining=copy?[...visibleIds]:visibleIds.filter(id=>!ids.includes(id)),at=remaining.indexOf(targetId)+(after?1:0);
  const next=[...remaining.slice(0,at),...(copy?copyIds:ordered),...remaining.slice(at)];
  // Hidden results keep their slots; insertion also works inside filtered lists.
  const visible=new Set(visibleIds),result=[];let cursor=0;
  for(const id of original){if(visible.has(id))result.push(next[cursor++]);else result.push(id);}
  result.push(...next.slice(cursor));
  return result;
}
function saveOrders(store,rows,ids){for(const [i,id] of ids.entries()){const row=rows.find(row=>row.id===id);if(row.draft.order!==i+1)store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify({...row.draft,order:i+1}),now(),id);}}
function saveSpaceOrder(store,spaces,main,revision){store.set('spacesDraft',spaces);store.set('mainSpaceDraft',main);store.set('spacesRevision',revision+1);}
function saveGlobalLabelOrder(store,order,spaces,main,revision){
  if(order.filter(label=>label!=='未分类').length>200)fail('最多支持200个标签。');
  const settings=store.get('settingsDraft');
  store.set('settingsDraft',{...settings,categories:order});store.set('settingsRevision',store.get('settingsRevision')+1);
  saveSpaceOrder(store,spaces.map(space=>orderLabelGroups(space,order)),orderLabelGroups(main,order),revision);
}
const tagMoveUndo=new WeakMap();
function undoTagMove(store,input){
  const saved=tagMoveUndo.get(store);
  if(!saved||typeof input.token!=='string'||input.token!==saved.token||Date.now()>saved.expires)fail('这次标签移动已无法撤销。',409);
  const row=store.project(saved.id);if(!row||row.deletedAt||row.revision!==saved.projectRevision||(store.get('spacesRevision')||1)!==saved.spacesRevision)fail('作品或空间已有后续修改，无法撤销这次移动。',409);
  const rows=store.projects().filter(row=>!row.deletedAt);assertProjectRevisions(rows,saved.revisions);
  store.transaction(()=>{store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(saved.document),now(),row.id);for(const previous of saved.orders){const current=rows.find(item=>item.id===previous.id);if(previous.id!==saved.id&&current.draft.order!==previous.order)store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify({...current.draft,order:previous.order}),now(),previous.id);}saveSpaceOrder(store,saved.spaces,saved.main,saved.spacesRevision);});
  tagMoveUndo.delete(store);return{ok:true,created:[]};
}
function moveWorkLabel(store,input,rows,spaces,main,revision){
  if(input.copy||!Array.isArray(input.ids)||input.ids.length!==1)fail('跨标签拖动每次移动一件作品。');
  const row=rows.find(row=>row.id===input.ids[0]),space=input.spaceId==='main'?main:spaces.find(space=>space.id===input.spaceId);
  if(!row||!space)fail('作品或空间不存在。',404);
  assertRevision(input.projectRevision,row.revision);
  const source=space.groups.find(group=>group.label===input.label),target=space.groups.find(group=>group.label===input.targetLabel);
  if(!source||!target||source===target||!orderedGroupProjects(source,rows).some(item=>item.id===row.id))fail('来源或目标标签已变化，请刷新后重试。',409);
  if(target.label==='未分类')fail('不能拖入未分类，移除标签请在作品编辑页操作。');
  const before={document:structuredClone(row.draft),spaces:structuredClone(spaces),main:structuredClone(main),orders:rows.map(item=>({id:item.id,order:item.draft.order}))};
  const labels=[...new Set([...projectLabels(row.draft).filter(label=>label!==source.label),target.label])];
  const document=validateProject({...row.draft,labels},row.draft,store);
  for(const current of [main,...spaces])for(const group of current.groups)if(group.label===source.label){group.projectIds=group.projectIds.filter(id=>id!==row.id);if(group.orderIds)group.orderIds=group.orderIds.filter(id=>id!==row.id);}
  if(target.mode==='selected'&&!target.projectIds.includes(row.id))target.projectIds.push(row.id);
  const nextRows=rows.map(item=>item.id===row.id?{...row,draft:document}:item),eligible=orderedGroupProjects(target,nextRows).map(item=>item.id);
  const visible=input.targetVisibleIds??eligible.filter(id=>id!==row.id);
  if(!Array.isArray(visible)||visible.length>5000||new Set(visible).size!==visible.length||visible.some(id=>!eligible.includes(id)))fail('目标列作品已变化，请刷新后重试。',409);
  const original=rows.map(item=>item.id),shown=visible.filter(id=>id!==row.id);let next=original;
  if(input.targetId==null){if(shown.length)fail('请选择有效的作品放置位置。',409);}
  else{
    if(!shown.includes(input.targetId)||typeof input.after!=='boolean')fail('目标作品位置已变化，请刷新后重试。',409);
    next=arrange(original,{ids:[row.id],visibleIds:original.filter(id=>id===row.id||shown.includes(id)),targetId:input.targetId,after:input.after,copy:false});
  }
  const orderChanged=next.some((id,index)=>id!==original[index]);if(orderChanged)document.order=next.indexOf(row.id)+1;
  const docs=nextRows.map(item=>item.draft);validateSpaces(spaces,docs);validateMainSpace(main,docs);
  store.transaction(()=>{store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(document),now(),row.id);if(orderChanged)saveOrders(store,nextRows,next);saveSpaceOrder(store,spaces,main,revision);});
  const token=randomBytes(24).toString('hex');tagMoveUndo.set(store,{...before,id:row.id,token,expires:Date.now()+5*60*1000,projectRevision:row.revision+1,spacesRevision:revision+1,revisions:store.projects().filter(item=>!item.deletedAt).map(item=>({id:item.id,revision:item.revision}))});
  return{ok:true,created:[],movedLabel:{from:source.label,to:target.label},undoToken:token};
}
export function arrangeContent(store,input){
  if(input?.kind==='undo-space-work')return undoTagMove(store,input);
  if(!input||!['tag','work','space','space-label','space-work'].includes(input.kind))fail('不支持此拖拽类型。');
  const rows=store.projects().filter(row=>!row.deletedAt),docs=rows.map(row=>row.draft),revision=store.get('spacesRevision')||1;
  let spaces=spacesDraft(store),main=mainSpace(store),created=[];
  if(input.kind==='work'){
    assertProjectRevisions(rows,input.revisions);
    const original=rows.map(row=>row.id);arrange(original,input);
    const copies=input.copy?original.filter(id=>input.ids.includes(id)).map(id=>{const source=rows.find(row=>row.id===id).draft;return validateProject({...source,title:(source.title.slice(0,114)+' · 副本').slice(0,120),blocks:source.blocks.map(block=>({...block,id:randomUUID()}))},null,store);}):[];
    const next=arrange(original,input,copies.map(doc=>doc.id));
    store.transaction(()=>{for(const document of copies){store.db.prepare('INSERT INTO projects(id,draft,updatedAt) VALUES(?,?,?)').run(document.id,JSON.stringify(document),now());created.push(document.id);}saveOrders(store,[...rows,...copies.map(draft=>({id:draft.id,draft}))],next);});
  }else if(input.kind==='tag'){
    assertRevision(input.revision,store.get('settingsRevision'));assertRevision(input.spacesRevision,revision);
    const original=labelOptions(store),settings=store.get('settingsDraft');arrange(original,input);
    if(input.ids.length!==1)fail('请一次拖动一个标签。');
    const source=input.ids[0],name=input.copy?uniqueName(source,original,40):null;
    if(name&&original.filter(label=>label!=='未分类').length>=200)fail('最多支持200个标签。');
    const affected=name?rows.filter(row=>projectLabels(row.draft).includes(source)):[];
    const changed=affected.map(row=>{const labels=[...projectLabels(row.draft),name];return{row,document:validateProject({...row.draft,labels},row.draft,store)};});
    const next=arrange(original,input,name?[name]:[]);
    if(name){const group=main.groups.find(group=>group.label===source);if(group)main={...main,groups:[...main.groups,{...structuredClone(group),label:name}]};created.push(name);}
    store.transaction(()=>{for(const {row,document} of changed)store.db.prepare('UPDATE projects SET draft=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(document),now(),row.id);saveGlobalLabelOrder(store,next,spaces,validateMainSpace(main,docs),revision);});
  }else{
    assertRevision(input.revision,revision);
    if(input.kind==='space-work')assertProjectRevisions(rows,input.revisions);
    if(input.kind==='space-work'&&input.targetLabel!=null&&input.targetLabel!==input.label)return moveWorkLabel(store,input,rows,spaces,main,revision);
    if(input.kind==='space'){
      const all=[main,...spaces],saved=main.navigationOrder||[],original=[...saved.filter(id=>all.some(space=>space.id===id)),...all.map(space=>space.id).filter(id=>!saved.includes(id))];arrange(original,input);
      if(input.ids.length!==1)fail('请一次拖动一个空间。');
      if(input.copy){if(spaces.length>=30)fail('分享空间最多30个。');const source=all.find(space=>space.id===input.ids[0]),{main:ignored,navigationOrder:ignoredOrder,...definition}=structuredClone(source),id='s-'+randomBytes(12).toString('hex');spaces.push({...definition,id,name:uniqueName(source.name,all.map(space=>space.name),40),accessVersion:randomBytes(12).toString('hex')});created.push(id);}
      const next=arrange(original,input,created);main={...main,navigationOrder:next};spaces.sort((a,b)=>next.indexOf(a.id)-next.indexOf(b.id));
    }else{
      const space=input.spaceId==='main'?main:spaces.find(space=>space.id===input.spaceId);if(!space)fail('分享空间不存在。',404);
      if(input.copy)fail('空间内的标签和作品仅支持排序。');
      if(input.kind==='space-label'){
        assertRevision(input.settingsRevision,store.get('settingsRevision'));
        const visible=space.groups.map(group=>group.label),chosen=input.visibleIds??visible;
        if(!Array.isArray(chosen)||chosen.some(label=>!visible.includes(label)))fail('空间包含的标签已经变化，请刷新后重试。',409);
        const next=arrange(globalLabelOrder(store),{...input,visibleIds:chosen});
        store.transaction(()=>saveGlobalLabelOrder(store,next,spaces,main,revision));return{ok:true,created};
      }else{
        const group=space.groups.find(group=>group.label===input.label);if(!group)fail('空间标签不存在。',404);
        const eligible=orderedGroupProjects(group,rows).map(row=>row.id),visible=input.visibleIds??eligible;
        if(!Array.isArray(visible)||visible.some(id=>!eligible.includes(id)))fail('当前列作品已变化，请刷新后重试。',409);
        const next=arrange(rows.map(row=>row.id),{...input,visibleIds:visible});
        if(next.some((id,index)=>id!==rows[index].id))store.transaction(()=>saveOrders(store,rows,next));return{ok:true,created};
      }
    }
    validateSpaces(spaces,docs);validateMainSpace(main,docs);
    store.transaction(()=>saveSpaceOrder(store,spaces,main,revision));
  }
  return {ok:true,created};
}
