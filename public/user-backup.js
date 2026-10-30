(() => {
  let restoring=false,dispose=null;
  window.PortfolioUserBackup={isRestoring:()=>restoring,close(){if(!restoring){dispose?.();dispose=null;}},async open({mode,api,esc,openDialog,modalHead,btn,beforeWork,onRestored}){
    const info=await api('/api/backups'),restore=mode==='restore';
    openDialog(`${modalHead(restore?'恢复数据':'备份数据',restore?'选择备份文件，再勾选需要恢复的数据。':'默认备份全部用户数据，也可以按类别选择。')}<form id="user-backup-form"><div class="modal-body user-backup-body">${restore?'<input type="file" accept=".zip,application/zip" data-backup-file hidden><button type="button" class="btn" data-backup="choose">选择备份文件</button><p class="inline-note">支持用户数据备份ZIP，也兼容新版网站部署包。</p><p class="backup-file-name"></p>':'<p class="inline-note blue">包含未公开草稿和原始素材，请将备份保存在自己的电脑中。</p>'}<div class="backup-options" ${restore?'hidden':''}>${info.sections.map(section=>`<label class="backup-option"><input type="checkbox" name="section" value="${section.id}" checked><span><strong>${esc(section.label)}</strong><small>${esc(section.description)}</small></span></label>`).join('')}</div><p class="backup-dependencies" ${restore?'hidden':''}>所选作品和设置依赖的素材会自动带上，无须单独勾选素材库。</p><p class="backup-summary" aria-live="polite"></p><p class="backup-warning" ${restore?'hidden':''}></p><p class="backup-progress" role="status"></p><div class="backup-download"></div><div class="form-error" role="alert" hidden></div></div><footer class="modal-foot">${btn('取消','close-dialog')}<button type="submit" class="btn primary" ${restore?'disabled':''}>${restore?'恢复所选数据':'备份并下载'}</button></footer></form>`);
    const form=document.querySelector('#user-backup-form'),get=selector=>form.querySelector(selector),submit=get('[type=submit]'),options=get('.backup-options'),message=get('.backup-progress'),error=get('.form-error');let token=null,legacy=false,working=false,active=true;
    dispose=()=>{active=false;if(token){api('/api/backups/pending/'+token,'DELETE').catch(()=>{});token=null;}};
    const checkboxes=()=>[...form.querySelectorAll('[name=section]')],sections=()=>checkboxes().filter(node=>node.checked&&!node.disabled).map(node=>node.value),showError=value=>{error.textContent=value||'';error.hidden=!value;};
    function setWorking(value){working=value;form.querySelectorAll('input,button').forEach(node=>{if(node.dataset.action!=='close-dialog')node.disabled=value||node.dataset.unavailable==='true';});submit.disabled=value||restore&&!token||!sections().length;}
    function dependencies(event){const target=event?.target,history=checkboxes().find(node=>node.value==='history');if(target&&['settings','projects'].includes(target.value)&&!target.checked)history.checked=false;if(history.checked)for(const node of checkboxes())if(['settings','projects'].includes(node.value))node.checked=true;submit.disabled=working||restore&&!token||!sections().length;}
    form.addEventListener('change',event=>{if(event.target.name==='section')dependencies(event);});
    async function watch(job){while(job.status==='running'){if(form.isConnected)message.textContent=job.message;await new Promise(resolve=>setTimeout(resolve,350));job=await api('/api/backups/jobs/'+job.id);}if(job.status!=='done')throw new Error(job.message);return job.result;}
    if(restore){
      get('[data-backup=choose]').addEventListener('click',()=>get('[data-backup-file]').click());
      get('[data-backup-file]').addEventListener('change',async event=>{
        const file=event.target.files[0];if(!file||working)return;setWorking(true);showError('');if(token)await api('/api/backups/pending/'+token,'DELETE').catch(()=>{});token=null;get('.backup-download').replaceChildren();get('.backup-summary').replaceChildren();get('.backup-warning').hidden=true;get('.backup-file-name').textContent=file.name;message.textContent='正在上传并检查备份文件…';
        try{const response=await fetch('/api/backups/inspect',{method:'POST',headers:{'Content-Type':'application/zip'},body:file}),result=await response.json();if(!response.ok)throw new Error(result.error||'备份检查失败。');if(!active){await api('/api/backups/pending/'+result.token,'DELETE').catch(()=>{});return;}token=result.token;legacy=result.legacy;
          for(const node of checkboxes()){const available=result.sections.includes(node.value);node.checked=available;node.dataset.unavailable=String(!available);node.closest('label').hidden=!available;}
          options.hidden=false;get('.backup-dependencies').hidden=false;get('.backup-summary').textContent=`${legacy?'网站部署包':'用户数据备份'}${result.title?' · '+result.title:''}：${result.counts.projects}个作品、${result.counts.media}件素材、${result.counts.folders}个文件夹、${result.counts.history}条发布历史。`;
          const warning=get('.backup-warning');warning.hidden=false;warning.textContent=legacy?'兼容恢复：所选作品和设置恢复为草稿，相同编号的草稿会被替换，其他作品和当前发布版本保留。':'恢复所选类别会替换当前对应数据，未选择的类别保留。为其他类别仍使用的素材会保留。恢复前会自动保存原数据副本；恢复仅影响后台，不会直接改动云端网站。';message.textContent='检查通过，请确认恢复类别。';
        }catch(failure){showError(failure.message);message.textContent='';options.hidden=true;}finally{setWorking(false);dependencies();}
      });
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();event.stopPropagation();if(working||restore&&!token)return;const chosen=sections();if(!chosen.length)return;let release;
      setWorking(true);showError('');get('.backup-download').replaceChildren();if(restore)restoring=true;
      try{
        release=await beforeWork();
        if(!active)return;
        if(restore){const job=await api('/api/backups/restore','POST',{token,sections:chosen});const result=await watch(job);restoring=false;token=null;message.textContent='所选数据已恢复，已保留恢复前的数据副本。';await onRestored(result);}
        else{const job=await api('/api/backups/create','POST',{sections:chosen}),result=await watch(job);if(!active)return;message.textContent='备份已准备，正在下载。';get('.backup-download').innerHTML=`<a class="btn" href="${esc(result.downloadUrl)}" download>重新下载备份</a>`;get('.backup-download a').click();}
      }catch(failure){showError(failure.message);message.textContent='';}finally{restoring=false;setWorking(false);release?.();}
    });
  }};
})();
