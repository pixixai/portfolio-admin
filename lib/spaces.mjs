import {randomBytes,scrypt as derive} from 'node:crypto';
import {promisify} from 'node:util';
import {projectLabels,orderedLabelNames,orderLabelGroups,withoutLocalProjectOrder} from './labels.mjs';
import {fail} from './validation.mjs';
import {encryptSpaceCode,decryptSpaceCode,validSpaceCodeSecret} from './space-secrets.mjs';

const scrypt=promisify(derive);
export const spaceIdPattern=/^s-[a-f0-9]{24}$/;
export const documentGroups=document=>projectLabels(document).length?projectLabels(document):['未分类'];
export function spaceGroups(space,documents=[]){
  if(Array.isArray(space.groups))return space.groups;
  const groups=(space.labels||[]).map(label=>({label,mode:'all',projectIds:[]}));
  for(const id of space.projectIds||[]){const document=documents.find(item=>item.id===id);for(const label of document?documentGroups(document):['未分类']){let group=groups.find(item=>item.label===label);if(!group){group={label,mode:'selected',projectIds:[]};groups.push(group);}if(group.mode!=='all')group.projectIds.push(id);}}
  return groups;
}
export function withGroups(space,groups){return{...space,groups,labels:groups.filter(group=>group.mode==='all').map(group=>group.label),projectIds:[...new Set(groups.flatMap(group=>group.projectIds))]};}
export function globalLabelOrder(store,version='Draft'){
  const documents=(store.projects?.()||[]).map(row=>row[version.toLowerCase()]).filter(Boolean);
  return orderedLabelNames(store.get('settings'+version),documents,[store.get('mainSpace'+version),...(store.get('spaces'+version)||[])]);
}
function readSpaces(store,key,version){const spaces=store.get?.(key)||[],documents=spaces.some(space=>!Array.isArray(space.groups))?store.projects?.().map(row=>row[version]).filter(Boolean)||[]:[],order=version==='draft'?globalLabelOrder(store):null;return spaces.map(space=>{const value=withGroups(space,spaceGroups(space,documents));return order?withoutLocalProjectOrder(orderLabelGroups(value,order)):value;});}
export const spacesDraft=store=>readSpaces(store,'spacesDraft','draft');
export const spacesLive=store=>readSpaces(store,'spacesLive','live');
export const isPrivate=document=>document?.visibility==='private';
export const groupIncludes=(group,document)=>!(group.excludedProjectIds||[]).includes(document.id)&&(group.mode==='all'?(documentGroups(document).includes(group.label)||group.projectIds.includes(document.id)):group.projectIds.includes(document.id));
export const includesProject=(space,document)=>!(space.excludedProjectIds||[]).includes(document.id)&&spaceGroups(space,[document]).some(group=>groupIncludes(group,document));
export const spaceProjectLabels=(space,document)=>(space.excludedProjectIds||[]).includes(document.id)?[]:spaceGroups(space,[document]).filter(group=>groupIncludes(group,document)).map(group=>group.label);
export function spaceDefinition(space){const{displayCode,...definition}=space;return definition;}
export function renameSpaceLabel(space,name,replacement){
  const groups=[];for(const original of space.groups){if(original.label===name&&!replacement)continue;const group={...original,label:original.label===name?replacement:original.label,projectIds:[...original.projectIds]},existing=groups.find(item=>item.label===group.label);if(existing){existing.mode=existing.mode==='all'||group.mode==='all'?'all':'selected';existing.excludedProjectIds=(existing.excludedProjectIds||[]).filter(id=>(group.excludedProjectIds||[]).includes(id));existing.projectIds=[...new Set([...existing.projectIds,...group.projectIds])];}else groups.push(group);}return withGroups(space,groups);
}
export function validateSpaces(value,documents=[]){
  if(!Array.isArray(value)||value.length>30)fail('分享空间最多30个。');
  const names=new Set(),ids=new Set();
  return value.map(space=>{
    if(!space||!spaceIdPattern.test(space.id)||ids.has(space.id)||typeof space.name!=='string'||!space.name.trim()||space.name.length>40||names.has(space.name.trim())||typeof space.enabled!=='boolean')fail('分享空间数据格式不正确。');
    if(space.groups==null&&(!Array.isArray(space.projectIds)||!Array.isArray(space.labels)||space.projectIds.length>5000||space.labels.length>200||space.projectIds.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]*$/.test(id))||space.labels.some(label=>typeof label!=='string'||!label.trim()||label.length>40)))fail('分享空间选择格式不正确。');
    if(space.groups!=null&&!Array.isArray(space.groups))fail('分享空间分组格式不正确。');
    const validIds=ids=>Array.isArray(ids)&&ids.length<=5000&&ids.every(id=>typeof id==='string'&&/^[a-z][a-z0-9-]*$/.test(id));
    if(space.selectionMode!=null&&space.selectionMode!=='tags'||space.excludedProjectIds!=null&&!validIds(space.excludedProjectIds))fail('分享空间排除列表不正确。');
    const raw=spaceGroups(space,documents);if(raw.length>201)fail('空间标签最多201个。');const groupNames=new Set();let selected=0;
    const groups=raw.map(group=>{if(!group||typeof group.label!=='string'||!group.label.trim()||group.label.length>40||groupNames.has(group.label)||!['all','selected'].includes(group.mode)||!Array.isArray(group.projectIds)||group.projectIds.length>5000||group.projectIds.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]*$/.test(id)))fail('分享空间标签或作品选择不正确。');groupNames.add(group.label);selected+=group.projectIds.length;if(selected>50000)fail('空间作品选择过多。');if(group.excludedProjectIds!=null&&!validIds(group.excludedProjectIds))fail('分享空间标签排除数据不正确。');if(group.orderIds!=null&&!validIds(group.orderIds))fail('空间作品顺序不正确。');return{...(group.orderIds?{orderIds:[...new Set(group.orderIds)]}:{}),label:group.label,mode:group.mode,projectIds:[...new Set(group.projectIds)],...(group.excludedProjectIds?.length?{excludedProjectIds:[...new Set(group.excludedProjectIds)]}:{})};}).filter(group=>group.mode==='all'||group.projectIds.length);
    if(space.includeMain!=null&&typeof space.includeMain!=='boolean')fail('主站作品选项格式不正确。');
    const mode=space.accessMode??'private';if(!['public','private'].includes(mode))fail('空间访问方式不正确。');
    const access=space.access;if((mode==='private'||access!=null)&&(!access||access.algorithm!=='scrypt'||access.N!==32768||access.r!==8||access.p!==3||!/^[a-f0-9]{32}$/.test(access.salt)||!/^[a-f0-9]{64}$/.test(access.hash)))fail('分享空间访问码数据不正确。');
    if(access?.codeLength!=null&&access.codeLength!==4)fail('分享空间访问码格式不正确。');
    if(space.accessVersion!=null&&!/^[a-f0-9]{24}$/.test(space.accessVersion))fail('空间访问版本不正确。');
    ids.add(space.id);names.add(space.name.trim());
    if(space.displayCode!=null&&!validSpaceCodeSecret(space.displayCode))fail('访问码显示数据不正确。');
    return withGroups({id:space.id,name:space.name.trim(),enabled:space.enabled,accessMode:mode,...(space.selectionMode?{selectionMode:space.selectionMode}:{}),...(space.excludedProjectIds?{excludedProjectIds:[...new Set(space.excludedProjectIds)]}:{}),includeMain:space.includeMain!==false,...(space.accessVersion?{accessVersion:space.accessVersion}:{}),access:access?{algorithm:'scrypt',N:32768,r:8,p:3,salt:access.salt,hash:access.hash,...(access.codeLength===4?{codeLength:4}:{})}:null,...(space.displayCode?{displayCode:space.displayCode}:{})},groups);
  });
}
export const mainSpace= (store,version='Draft')=>version==='Live'?store.get('mainSpaceLive'):withoutLocalProjectOrder(orderLabelGroups(store.get('mainSpace'+version),globalLabelOrder(store,version)));
export function explicitGroups(space,documents){return withGroups(space,spaceGroups(space,documents).map(group=>({label:group.label,mode:'selected',projectIds:documents.filter(doc=>groupIncludes(group,doc)).map(doc=>doc.id)})).filter(group=>group.projectIds.length));}
export function validateMainSpace(value,documents=[]){
  if(!value||value.id!=='main'||typeof value.name!=='string'||!value.name.trim()||value.name.length>40)fail('主站空间格式不正确。');
  if(value.navigationOrder!=null&&(!Array.isArray(value.navigationOrder)||value.navigationOrder.length>31||new Set(value.navigationOrder).size!==value.navigationOrder.length||value.navigationOrder.some(id=>id!=='main'&&!spaceIdPattern.test(id))))fail('空间导航顺序不正确。');
  // Reuse bounded group validation without giving the main site credentials.
  const fake={...value,id:'s-'+'0'.repeat(24),enabled:true,accessMode:'public',access:null};
  const checked=validateSpaces([fake],documents)[0];return{...checked,id:'main',name:value.name.trim(),enabled:true,accessMode:'public',main:true,...(value.navigationOrder?{navigationOrder:value.navigationOrder}:{})};
}
// Retain existing per-tag choices during migration; new works follow selected tags.
export function automaticSpace(space,documents){
  if(space.selectionMode==='tags')return space;
  const previous=spaceGroups(space,documents),eligible=documents.filter(doc=>previous.some(group=>documentGroups(doc).includes(group.label)||groupIncludes(group,doc))),excluded=eligible.filter(doc=>!includesProject(space,doc)).map(doc=>doc.id);
  return withGroups({...space,selectionMode:'tags',excludedProjectIds:[...new Set([...(space.excludedProjectIds||[]),...excluded])]},previous.map(group=>({label:group.label,mode:'all',projectIds:group.projectIds.filter(id=>{const doc=documents.find(doc=>doc.id===id);return !doc||!documentGroups(doc).includes(group.label);}),excludedProjectIds:documents.filter(doc=>documentGroups(doc).includes(group.label)&&!groupIncludes(group,doc)).map(doc=>doc.id)})));
}
export function initializeDisplaySpaces(store){
  if(store.get('displaySpacesVersion')===1&&[mainSpace(store),mainSpace(store,'Live'),...spacesDraft(store),...spacesLive(store)].filter(Boolean).every(space=>space.selectionMode==='tags'))return;
  let changed=false;
  store.transaction(()=>{
    if(store.get('displaySpacesVersion')!==1){
      for(const [version,key] of [['draft','Draft'],['live','Live']]){
        const documents=store.projects().map(row=>row[version]).filter(Boolean),spaces=key==='Draft'?spacesDraft(store):spacesLive(store),publicDocs=documents.filter(doc=>!isPrivate(doc)&&!spaces.some(space=>includesProject(space,doc))),labels=[...new Set(publicDocs.flatMap(documentGroups))];
        if(!mainSpace(store,key))store.set('mainSpace'+key,{id:'main',main:true,name:'主站',enabled:true,accessMode:'public',groups:labels.map(label=>({label,mode:'selected',projectIds:publicDocs.filter(doc=>documentGroups(doc).includes(label)).map(doc=>doc.id)}))});
        store.set('spaces'+key,spaces);changed=true;
      }
      store.set('displaySpacesVersion',1);
    }
    for(const [version,key] of [['draft','Draft'],['live','Live']]){
      const documents=store.projects().map(row=>row[version]).filter(Boolean),main=mainSpace(store,key),spaces=key==='Draft'?spacesDraft(store):spacesLive(store);
      if(main&&main.selectionMode!=='tags'){store.set('mainSpace'+key,{...automaticSpace(main,documents),name:'主站'});changed=true;}
      if(spaces.some(space=>space.selectionMode!=='tags')){store.set('spaces'+key,spaces.map(space=>automaticSpace({...space,accessMode:space.accessMode||'private'},documents)));changed=true;}
    }
    if(changed)store.set('spacesRevision',(store.get('spacesRevision')||1)+1);
  });
}
export const syncSpaceVisibility=initializeDisplaySpaces;
export function enforcePrivacy(document){if(document.visibility!=null&&!['public','private'].includes(document.visibility))fail('作品可见范围不正确。');return document;}
function commitSpaces(store,spaces,main,revision){store.set('spacesDraft',spaces);store.set('mainSpaceDraft',main);store.set('spacesRevision',revision+1);}
export function saveProjectSpaces(store,id,input){
  const row=store.project(id);if(!row||row.deletedAt)fail('作品不存在。',404);
  const revision=store.get('spacesRevision')||1;if(input.spacesRevision!==revision||input.revision!==row.revision)fail('作品或空间已在别处修改，请刷新后重试。',409);
  const rows=store.projects(),docs=rows.map(row=>row.draft),activeIds=new Set(rows.filter(row=>!row.deletedAt).map(row=>row.id)),all=[mainSpace(store),...spacesDraft(store)].map(space=>space.selectionMode==='tags'?structuredClone(space):explicitGroups(space,docs));
  const originalLabels=new Set(documentGroups(row.draft));
  if(input.byLabel!=null){
    if(typeof input.byLabel!=='string'||!originalLabels.has(input.byLabel))fail('请先添加有效的作品标签。');
    for(const space of all){const group=space.groups.find(group=>group.label===input.byLabel);if(group&&(space.selectionMode==='tags'||group.projectIds.some(key=>activeIds.has(key)))){group.projectIds=[...new Set([...group.projectIds,id])];group.excludedProjectIds=(group.excludedProjectIds||[]).filter(key=>key!==id);space.excludedProjectIds=(space.excludedProjectIds||[]).filter(key=>key!==id);}}
  }else{
    if(!Array.isArray(input.spaces)||input.spaces.length>31)fail('分享空间选择不正确。');const chosen=new Map();
    for(const item of input.spaces){const space=all.find(space=>space.id===item?.id);if(!item||!space||chosen.has(item.id)||!Array.isArray(item.labels)||item.labels.length>201||item.labels.some(label=>typeof label!=='string'||!label.trim()||label.length>40||!originalLabels.has(label)&&!space.groups.some(group=>group.label===label&&group.projectIds.includes(id))))fail('分享空间或展示标签不正确。');chosen.set(item.id,[...new Set(item.labels)]);}
    for(const space of all){if(space.selectionMode==='tags'){const wanted=chosen.get(space.id)||[];space.excludedProjectIds=wanted.length?(space.excludedProjectIds||[]).filter(key=>key!==id):[...new Set([...(space.excludedProjectIds||[]),id])];for(const group of space.groups)group.excludedProjectIds=wanted.includes(group.label)?(group.excludedProjectIds||[]).filter(key=>key!==id):[...new Set([...(group.excludedProjectIds||[]),id])];for(const label of wanted)if(!space.groups.some(group=>group.label===label))space.groups.push({label,mode:'selected',projectIds:[id]});continue;}for(const group of space.groups)group.projectIds=group.projectIds.filter(key=>key!==id);for(const label of chosen.get(space.id)||[]){let group=space.groups.find(group=>group.label===label);if(!group){group={label,mode:'selected',projectIds:[]};space.groups.push(group);}group.projectIds.push(id);}space.groups=space.groups.filter(group=>group.projectIds.length);}
  }
  store.transaction(()=>commitSpaces(store,all.slice(1),all[0],revision));return spaceState(store);
}
export function spaceState(store){
  const draft=spacesDraft(store),live=spacesLive(store),projects=store.projects().filter(row=>!row.deletedAt);
  return{main:mainSpace(store),revision:store.get('spacesRevision')||1,changed:JSON.stringify(mainSpace(store))!==JSON.stringify(mainSpace(store,'Live'))||JSON.stringify(draft.map(spaceDefinition))!==JSON.stringify(live.map(spaceDefinition)),items:draft.map(({access,displayCode,...space})=>({...space,code:decryptSpaceCode({displayCode},store.get('spaceCodeKey')),count:projects.filter(row=>includesProject(space,row.draft)).length,published:live.some(item=>item.id===space.id),changed:JSON.stringify(spaceDefinition(draft.find(item=>item.id===space.id)))!==JSON.stringify(live.find(item=>item.id===space.id)?spaceDefinition(live.find(item=>item.id===space.id)):null)}))};
}
export async function saveSpace(store,input,id=null){
  if(input?.revision!==(store.get('spacesRevision')||1))fail('分享空间已在别处修改，请刷新后重试。',409);
  const before=spacesDraft(store),previous=id?before.find(space=>space.id===id):null;
  if(id&&!previous)fail('分享空间不存在。',404);
  if(!previous&&before.length>=30)fail('分享空间最多30个。');
  if(input.code!=null&&typeof input.code!=='string')fail('访问码需为4位数字。');
  let access=previous?.access,displayCode=previous?.displayCode,displayKey=store.get('spaceCodeKey');
  if(input.code&&input.code!==decryptSpaceCode(previous||{},displayKey)){
    if(typeof input.code!=='string'||!/^\d{4}$/.test(input.code))fail('访问码需为4位数字。');
    const salt=randomBytes(16).toString('hex'),hash=(await scrypt(input.code,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:3,maxmem:64*1024**2})).toString('hex');
    access={algorithm:'scrypt',N:32768,r:8,p:3,salt,hash,codeLength:4};
    displayKey ||= randomBytes(32).toString('hex');displayCode=encryptSpaceCode(input.code,displayKey);
  }
  const mode=input.accessMode??previous?.accessMode??'private';if(mode==='private'&&!access)fail('请设置访问码。');
  // Recheck after the asynchronous password derivation, before touching any rows.
  if(input.revision!==(store.get('spacesRevision')||1))fail('分享空间已在别处修改，请刷新后重试。',409);
  const rows=store.projects(),space={id:id||'s-'+randomBytes(12).toString('hex'),name:input.name??previous?.name,enabled:input.enabled??previous?.enabled??true,accessMode:mode,...(input.selectionMode||previous?.selectionMode?{selectionMode:input.selectionMode||previous.selectionMode}:{}),excludedProjectIds:input.excludedProjectIds??previous?.excludedProjectIds??[],includeMain:input.includeMain??previous?.includeMain??true,accessVersion:previous&&mode===previous.accessMode?previous.accessVersion:randomBytes(12).toString('hex'),access:access||null,...(displayCode?{displayCode}:{})};
  if(!previous&&input.includeMain!==false&&input.groups==null&&input.projectIds==null&&input.labels==null){space.selectionMode='tags';space.groups=mainSpace(store).groups.map(group=>({label:group.label,mode:'all',projectIds:[]}));}
  else if(input.groups!=null)space.groups=input.groups;else if(input.projectIds!=null||input.labels!=null){space.projectIds=input.projectIds??previous?.projectIds??[];space.labels=input.labels??previous?.labels??[];}else space.groups=previous?.groups||[];
  const checked=validateSpaces(previous?before.map(item=>item.id===id?space:item):[...before,space],rows.map(row=>row.draft)),saved=checked.find(item=>item.id===space.id);
  if(saved.projectIds.some(key=>!rows.some(row=>row.id===key&&!row.deletedAt)&&!previous?.projectIds.includes(key)))fail('选择的作品不存在。');
  const spaces=checked.map(item=>item.selectionMode==='tags'?item:explicitGroups(item,rows.map(row=>row.draft)));
  store.transaction(()=>{if(displayKey)store.set('spaceCodeKey',displayKey);store.set('spacesDraft',spaces);store.set('spacesRevision',input.revision+1);});
  return spaceState(store);
}
export function deleteSpace(store,id,revision){
  if(revision!==(store.get('spacesRevision')||1))fail('分享空间已在别处修改，请刷新后重试。',409);
  const before=spacesDraft(store);if(!before.some(space=>space.id===id))fail('分享空间不存在。',404);
  store.transaction(()=>{store.set('spacesDraft',before.filter(space=>space.id!==id));store.set('spacesRevision',revision+1);});
  return spaceState(store);
}

export function saveMainSpace(store,input){
 const revision=store.get('spacesRevision')||1;if(input.revision!==revision)fail('分享空间已在别处修改，请刷新后重试。',409);
 const docs=store.projects().map(row=>row.draft),checked=validateMainSpace({...mainSpace(store),...input,id:'main'},docs);if(checked.groups.some(group=>group.projectIds.some(id=>!docs.some(doc=>doc.id===id)&&!mainSpace(store).groups.some(old=>old.projectIds.includes(id)))))fail('选择的作品不存在。');const main=checked.selectionMode==='tags'?checked:explicitGroups(checked,docs);
 store.transaction(()=>commitSpaces(store,spacesDraft(store),main,revision));return spaceState(store);
}

// Deployment-package recovery opts the recovered main-site tags back into the main scope.
export function includeMainProjects(store,documents){
 const main=mainSpace(store);if(!main)return;const groups=structuredClone(main.groups),restored=new Set(documents.map(doc=>doc.id));
 for(const doc of documents)for(const label of documentGroups(doc)){let group=groups.find(group=>group.label===label);if(!group){group={label,mode:main.selectionMode==='tags'?'all':'selected',projectIds:[]};groups.push(group);}if(group.mode==='selected')group.projectIds=[...new Set([...group.projectIds,doc.id])];group.excludedProjectIds=(group.excludedProjectIds||[]).filter(id=>id!==doc.id);}
 store.set('mainSpaceDraft',withGroups({...main,excludedProjectIds:(main.excludedProjectIds||[]).filter(id=>!restored.has(id))},groups));
}
