// Direct tag/tab dragging, local ordering, and global work-tag changes.
(()=>{
 let pending=null,drag=null,saving=false,allowRefresh=false,frame=0,suppressUntil=0,suppressItem=null;
 const itemSelector='[data-arrange-item]';
 const peers=parent=>[...parent.children].filter(node=>node.matches(itemSelector));
 const allowedCopy=kind=>kind==='tag'||kind==='space';
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 function rect(node){const r=node.getBoundingClientRect(),x=Number(window.gsap?.getProperty?.(node,'x'))||0,y=Number(window.gsap?.getProperty?.(node,'y'))||0;return{left:r.left-x,right:r.right-x,top:r.top-y,bottom:r.bottom-y,width:r.width,height:r.height};}
 const contains=(r,x,y)=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
 function animated(nodes,change){
  nodes=[...new Set(nodes)].filter(node=>node.isConnected&&node.nodeType===1);
  const before=new Map(nodes.map(node=>[node,node.getBoundingClientRect()]));
  window.gsap?.killTweensOf(nodes);nodes.forEach(node=>node.style.transform='');change();
  if(!window.gsap||reduced())return;
  const after=nodes.filter(node=>node.isConnected).map(node=>[node,node.getBoundingClientRect()]);
  for(const [node,r] of after){const old=before.get(node),x=old.left-r.left,y=old.top-r.top;if(Math.abs(x)+Math.abs(y)>.5)window.gsap.fromTo(node,{x,y},{x:0,y:0,duration:.22,ease:'power2.out',overwrite:true,clearProps:'transform'});}
 }
 function track(state,parent){if(!state.parents.has(parent))state.parents.set(parent,[...parent.childNodes]);}
 function layoutNodes(state){return [...state.parents.keys()].flatMap(parent=>peers(parent));}
 function removeHighlights(state){for(const node of state.highlights)node.classList.remove('content-arrange-destination','content-arrange-invalid');state.highlights.clear();}
 function restoreDOM(state){
  state.placeholder?.remove();state.placeholder=null;
  for(const [parent,children] of state.parents){parent.classList.remove('has-arrange-gap');if(parent.isConnected)parent.append(...children);}
  state.targetMember?.classList.remove('content-arrange-target-member');state.targetMember=null;removeHighlights(state);
 }
 function markers(){
  const line=document.createElement('div');line.id='content-arrange-marker';line.hidden=true;document.body.append(line);
  const ghost=document.createElement('div');ghost.id='content-arrange-preview';document.body.append(ghost);
 }
 function message(){if(!drag)return;const ghost=document.querySelector('#content-arrange-preview');
  ghost.textContent=drag.invalidLabel?'不能拖入未分类':drag.drop?.cross?`更改标签：${drag.label} → ${drag.drop.targetLabel} · 所有空间同步`:(drag.copy?'＋ 复制':'移动')+' '+drag.name;
  ghost.classList.toggle('is-label-change',!!drag.drop?.cross);ghost.classList.toggle('is-invalid',!!drag.invalidLabel);
  Object.assign(ghost.style,{left:`${drag.x+16}px`,top:`${drag.y+14}px`});
 }
 function mode(event){if(!drag)return;const next=allowedCopy(drag.kind)&&!!event.altKey;
  if(next!==drag.copy){drag.copy=next;drag.drop=null;drag.invalidLabel=null;animated(layoutNodes(drag),()=>restoreDOM(drag));}
  document.body.classList.toggle('content-copying',next);if(event.dataTransfer)event.dataTransfer.dropEffect=next?'copy':'move';message();
 }
 function draw(){
  if(!drag)return;const line=document.querySelector('#content-arrange-marker'),drop=drag.drop;line.hidden=!drop;
  if(drop){const gap=parseFloat(getComputedStyle(drop.parent).columnGap)||0,r=rect(drag.placeholder||drag.targetMember||drop.target||drop.parent),horizontal=drag.horizontal;
   line.dataset.target=drop.targetId||'';line.dataset.side=drop.after?'after':'before';line.dataset.label=drop.targetLabel||'';
   const slot=!!(drag.placeholder||drag.targetMember);
   Object.assign(line.style,horizontal?{left:`${(slot?r.left:drop.after?r.right:r.left)+(slot?-gap/2:drop.after?gap/2:-gap/2)-1}px`,top:`${r.top}px`,width:'2px',height:`${r.height}px`}:{left:`${r.left}px`,top:`${slot?r.top:drop.after?r.bottom:r.top}px`,width:`${r.width}px`,height:'2px'});
  }
  message();
 }
 function place(drop){
  const state=drag,previous=state.drop;
  if(previous&&previous.parent===drop.parent&&previous.targetId===drop.targetId&&previous.after===drop.after&&previous.cross===drop.cross&&previous.copy===state.copy){draw();return;}
  track(state,drop.parent);drop.copy=state.copy;state.invalidLabel=null;
  animated(layoutNodes(state),()=>{
   restoreDOM(state);
   let moving=state.node;
   if(drop.cross||state.copy){
    const existing=drop.cross?peers(drop.parent).find(node=>node.dataset.arrangeId===state.id):null;
    if(existing){moving=existing;state.targetMember=existing;existing.classList.add('content-arrange-target-member');}
    else{moving=document.createElement(state.kind==='space-work'?'div':'span');moving.className='content-arrange-gap';moving.setAttribute('aria-hidden','true');const r=rect(state.node);moving.style.height=`${r.height}px`;moving.style.width=state.horizontal?`${r.width}px`:'100%';if(drop.cross)moving.textContent=state.name;state.placeholder=moving;}
    drop.parent.classList.add('has-arrange-gap');
   }
   if(state.kind==='space-label'&&drop.parent.classList.contains('share-label-choices')){
    const original=state.parents.get(drop.parent),items=original.filter(node=>node.nodeType===1&&node.dataset.arrangeItem==='space-label'),remaining=items.filter(node=>node!==moving),index=remaining.indexOf(drop.target)+(drop.after?1:0),next=[...remaining.slice(0,index),moving,...remaining.slice(index)],selected=new Set(items);let cursor=0;
    drop.parent.append(...original.map(node=>selected.has(node)?next[cursor++]:node));
   }else if(drop.target)drop.target[drop.after?'after':'before'](moving);else drop.parent.prepend(moving);
   if(drop.cross){drop.column.classList.add('content-arrange-destination');state.highlights.add(drop.column);}
  });
  state.drop=drop;draw();
 }
 function clearDrop(invalidColumn=null){
  if(drag.drop||drag.invalidLabel!==invalidColumn?.dataset.spaceColumn){animated(layoutNodes(drag),()=>restoreDOM(drag));drag.drop=null;drag.invalidLabel=invalidColumn?.dataset.spaceColumn||null;}
  if(invalidColumn){invalidColumn.classList.add('content-arrange-invalid');drag.highlights.add(invalidColumn);}draw();
 }
 function hit(x,y){
  if(!drag)return;const state=drag;state.x=x;state.y=y;
  let parent=state.parent,column=null,targetLabel=state.label,cross=false;
  if(state.kind==='space-work'){
   column=[...document.querySelectorAll('.space-board>.space-column')].find(node=>contains(rect(node),x,y));
   if(column){parent=column.querySelector('.space-column-body');targetLabel=column.dataset.spaceColumn;cross=targetLabel!==state.label;if(cross&&targetLabel==='未分类')return clearDrop(column);}
  }
  const bounds=rect(parent),inside=column?true:x>=bounds.left-25&&x<=bounds.right+25&&y>=bounds.top-25&&y<=bounds.bottom+25;
  if(!inside)return clearDrop();
  if(state.drop?.parent===parent&&[state.placeholder,state.targetMember,!state.copy&&!cross?state.node:null].some(node=>node&&contains(rect(node),x,y))){draw();return;}
  if(!state.copy&&!cross&&!state.drop&&contains(rect(state.node),x,y)){draw();return;}
  const nodes=peers(parent).filter(node=>node.dataset.arrangeItem===state.kind&&(state.copy||node!==state.node)&&(!cross||node.dataset.arrangeId!==state.id));
  let target=nodes.find(node=>contains(rect(node),x,y));
  if(!target)target=nodes.reduce((best,node)=>{const r=rect(node),distance=state.horizontal?Math.hypot(x-(r.left+r.width/2),y-(r.top+r.height/2)):Math.abs(y-(r.top+r.height/2));return!best||distance<best.distance?{node,distance}:best;},null)?.node;
  if(!target&&!cross)return clearDrop();
  const r=target?rect(target):bounds,after=target?(state.horizontal?x>r.left+r.width/2:y>r.top+r.height/2):false;
  place({parent,target:target||null,targetId:target?.dataset.arrangeId||null,after,cross,column,targetLabel});
 }
 function scroll(){
  if(!drag)return;const {x,y}=drag,board=drag.node.closest('.space-board'),body=drag.drop?.parent||drag.parent;
  if(board){const r=board.getBoundingClientRect();board.scrollLeft+=x<r.left+45?-12:x>r.right-45?12:0;}
  if(drag.kind==='space-work'){const r=body.getBoundingClientRect();body.scrollTop+=y<r.top+45?-12:y>r.bottom-45?12:0;}
  const page=document.scrollingElement;if(page)page.scrollTop+=y<50?-12:y>innerHeight-50?12:0;
  hit(x,y);frame=requestAnimationFrame(scroll);
 }
 function descriptor(target){
  const grip=target.closest?.('[data-arrange-grip],[data-arrange-handle]');if(!grip||grip.dataset.arrangeHandle==='work')return null;
  const node=grip.closest(itemSelector);if(!node)return null;
  return{node,grip,direct:grip.hasAttribute('data-arrange-grip'),kind:node.dataset.arrangeItem,id:node.dataset.arrangeId,parent:node.parentElement,spaceId:activeSpaceId,label:node.dataset.label};
 }
 function start(event,native=false){
  const state=pending;if(!state||!state.node.isConnected||saving)return false;
  const name=state.kind==='tag'||state.kind==='space-label'?state.id:state.node.querySelector('.share-space-tab-name,.space-work-text strong')?.textContent.trim()||state.id;
  drag={...state,name,native,copy:false,horizontal:state.kind!=='space-work',parents:new Map(),highlights:new Set(),visibleIds:peers(state.parent).filter(node=>node.dataset.arrangeItem===state.kind).map(node=>node.dataset.arrangeId),projectRevision:db.projects.find(row=>row.id===state.id)?.revision,projectRevisions:state.kind==='space-work'?activeProjects().map(row=>({id:row.id,revision:row.revision})):null};
  track(drag,state.parent);drag.node.classList.add('content-arrange-source');document.body.classList.add('content-arranging');
  if(!native)state.grip.setPointerCapture?.(state.pointer);
  markers();drag.x=event.clientX;drag.y=event.clientY;mode(event);hit(event.clientX,event.clientY);frame=requestAnimationFrame(scroll);return true;
 }
 function release(){cancelAnimationFrame(frame);frame=0;if(pending?.grip.hasPointerCapture?.(pending.pointer))pending.grip.releasePointerCapture(pending.pointer);pending=null;drag=null;document.body.classList.remove('content-arranging','content-copying');document.querySelector('#content-arrange-marker')?.remove();document.querySelector('#content-arrange-preview')?.remove();}
 function nodeKey(node){return node.dataset.arrangeItem+'|'+(node.closest('.space-column-body')?.dataset.spaceColumnScroll||node.parentElement.className)+'|'+node.dataset.arrangeId;}
 function refresh(current){
  const relevant=node=>node.dataset.arrangeItem===(current?.kind||'space-work');
  const before=new Map([...document.querySelectorAll(itemSelector)].filter(relevant).map(node=>[nodeKey(node),node.getBoundingClientRect()]));
  if(current?.drop?.cross&&current.placeholder)before.set('space-work|'+current.drop.targetLabel+'|'+current.id,current.placeholder.getBoundingClientRect());
  window.gsap?.killTweensOf([...document.querySelectorAll(itemSelector)]);allowRefresh=true;
  try{if(view==='spaces')refreshSpaceView();else if(view==='works'){refreshCategories();$('#works-results').innerHTML=renderWorksResults();}}finally{allowRefresh=false;}
  if(window.gsap&&!reduced())for(const node of [...document.querySelectorAll(itemSelector)].filter(relevant)){const old=before.get(nodeKey(node));if(!old)continue;const r=node.getBoundingClientRect(),x=old.left-r.left,y=old.top-r.top;if(Math.abs(x)+Math.abs(y)>.5)window.gsap.fromTo(node,{x,y},{x:0,y:0,duration:.22,ease:'power2.out',overwrite:true,clearProps:'transform'});}
 }
 function undoNotice(result){
  const notice=document.createElement('div');notice.className='toast';notice.innerHTML=icon('check');const label=document.createElement('span');label.textContent=`已将「${result.movedLabel.from}」改为「${result.movedLabel.to}」`;const button=document.createElement('button');button.type='button';button.className='arrange-undo';button.textContent='撤销';notice.append(label,button);$('#toasts').append(notice);
  const timer=setTimeout(()=>notice.remove(),15000);
  button.addEventListener('click',async()=>{
   if(uploading){toast('媒体正在上传，完成后再撤销');return;}
   button.disabled=true;button.textContent='撤销中…';const shell=$('.editor-shell'),wasInert=shell?.inert;if(shell)shell.inert=true;
   try{
    if(editor)await saveProject(true);await flushSpaceChanges();await api('/api/arrange','POST',{kind:'undo-space-work',token:result.undoToken});await loadState(false);
    if(editor){const row=db.projects.find(row=>row.id===editor.id);if(row){editor={...copy(row.draft),revision:row.revision};render();}}else refresh();
    clearTimeout(timer);notice.remove();toast('已撤销标签移动，发布后生效');
   }catch(error){button.remove();toast(error.message,true);}
   finally{if(shell?.isConnected)shell.inert=wasInert;}
  });
 }
 async function finish(cancel=false){
  const current=drag;
  if(!current){release();return;}
  suppressUntil=Date.now()+400;suppressItem={kind:current.kind,id:current.id};
  if(cancel||!current.drop){animated(layoutNodes(current),()=>restoreDOM(current));current.node.classList.remove('content-arrange-source');release();return;}
  const drop=current.drop,visibleTarget=current.parents.get(drop.parent)?.filter(node=>node.nodeType===1&&node.dataset.arrangeItem==='space-work').map(node=>node.dataset.arrangeId)||[];
  saving=true;release();
  try{
   if(current.kind==='tag'&&categorySaving)await categorySaving;if(current.kind!=='tag')await flushSpaceChanges();
   const result=await api('/api/arrange','POST',{kind:current.kind,ids:[current.id],visibleIds:current.visibleIds,targetId:drop.targetId,after:drop.after,copy:current.copy,revision:current.kind==='tag'?db.settingsRevision:db.spaces.revision,spacesRevision:db.spaces.revision,settingsRevision:db.settingsRevision,revisions:current.projectRevisions,spaceId:current.spaceId,label:current.label,...(drop.cross?{targetLabel:drop.targetLabel,targetVisibleIds:visibleTarget,projectRevision:current.projectRevision}:{})});
   await loadState(false);if(current.copy&&current.kind==='space')activeSpaceId=result.created[0];refresh(current);
   if(result.undoToken)undoNotice(result);else toast(current.copy?'副本已创建，发布后生效':'顺序已保存，发布后生效');
  }catch(error){animated(layoutNodes(current),()=>restoreDOM(current));await loadState(false).catch(()=>{});refresh();toast(error.message,true);}
  finally{current.node.classList.remove('content-arrange-source');current.placeholder?.remove();current.targetMember?.classList.remove('content-arrange-target-member');removeHighlights(current);for(const parent of current.parents.keys())parent.classList.remove('has-arrange-gap');saving=false;}
 }
 document.addEventListener('pointerdown',event=>{const state=descriptor(event.target);if(!state||event.target.closest('input,[data-action=delete-category],[data-action=space-delete]')||event.button>0||editor)return;
  if(saving){event.preventDefault();return;}event.stopImmediatePropagation();if(!state.direct)event.preventDefault();pending={...state,pointer:event.pointerId,startX:event.clientX,startY:event.clientY};
 },true);
 document.addEventListener('pointermove',event=>{if(!pending||pending.pointer!==event.pointerId||drag?.native)return;
  if(!drag&&Math.hypot(event.clientX-pending.startX,event.clientY-pending.startY)<7)return;
  event.preventDefault();event.stopImmediatePropagation();if(!drag)start(event);if(drag){mode(event);hit(event.clientX,event.clientY);}
 },{capture:true,passive:false});
 document.addEventListener('pointerup',event=>{if(pending?.pointer!==event.pointerId||drag?.native)return;if(!drag){pending=null;return;}event.preventDefault();event.stopImmediatePropagation();mode(event);hit(event.clientX,event.clientY);finish();},true);
 document.addEventListener('pointercancel',()=>{if(pending&&!drag?.native)finish(true);},true);
 document.addEventListener('dragstart',event=>{const state=descriptor(event.target);if(!state)return;event.stopImmediatePropagation();if(drag||saving){event.preventDefault();return;}pending=state;if(start(event,true)){event.dataTransfer.setData('text/plain',state.id);event.dataTransfer.effectAllowed=allowedCopy(state.kind)?'copyMove':'move';}},true);
 document.addEventListener('dragover',event=>{if(!drag?.native)return;event.preventDefault();event.stopImmediatePropagation();mode(event);hit(event.clientX,event.clientY);},true);
 document.addEventListener('drop',event=>{if(!drag?.native)return;event.preventDefault();event.stopImmediatePropagation();mode(event);hit(event.clientX,event.clientY);finish();},true);
 document.addEventListener('dragend',()=>{if(drag?.native)finish(true);},true);
 document.addEventListener('keydown',event=>{if(!drag&&!pending)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(true);}else if(event.key==='Alt'&&drag){event.preventDefault();mode({altKey:true});hit(drag.x,drag.y);}},true);
 document.addEventListener('keyup',event=>{if(drag&&event.key==='Alt'){mode({altKey:false});hit(drag.x,drag.y);}},true);
 const suppress=event=>{if(event.target.closest?.('[data-action=edit],[data-action=delete-category],[data-action=space-delete]'))return;const node=event.target.closest?.(itemSelector);if(event.target.closest?.('[data-arrange-handle]')||Date.now()<suppressUntil&&node?.dataset.arrangeItem===suppressItem?.kind&&node?.dataset.arrangeId===suppressItem?.id){event.preventDefault();event.stopImmediatePropagation();}};
 document.addEventListener('click',suppress,true);document.addEventListener('dblclick',suppress,true);
 window.addEventListener('blur',()=>{if(pending||drag)finish(true);});
 window.PortfolioArrange={isDragging:()=>!!drag||saving&&!allowRefresh};
})();
