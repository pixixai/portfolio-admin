(() => {
  window.PortfolioRemoteSync={async open({api,esc,openDialog,modalHead,btn,sizeLabel,releaseId}){
    const state=await api('/api/remote'),profile=state.profile;
    openDialog(`${modalHead('增量部署到阿里云','部署本地已发布版本；只上传变化文件，成功后清理失效文件。')}<form id="remote-sync-form"><div class="modal-body remote-sync-body"><p class="inline-note blue">需要服务器SSH连接及Python3。网站目录须已在宝塔创建。密码和私钥仅用于本次连接，不保存、不随部署包导出。</p><div class="remote-sync-fields"><label class="field"><span>服务器IP或域名</span><input name="host" required value="${esc(profile.host)}" placeholder="填写阿里云服务器公网IP"></label><label class="field"><span>SSH端口</span><input name="port" required type="number" min="1" max="65535" value="${profile.port}"></label><label class="field"><span>SSH用户名</span><input name="username" required value="${esc(profile.username)}"></label><label class="field remote-full"><span>网站目录</span><input name="directory" required value="${esc(profile.directory)}"><small>例如 /www/wwwroot/pixixai.com，不是宝塔面板地址。</small></label></div><label class="field"><span>服务器SSH指纹</span><div class="remote-fingerprint"><input name="fingerprint" value="${esc(profile.fingerprint)}" readonly placeholder="首次连接先获取指纹"><button class="btn small" type="button" data-remote="fingerprint">获取指纹</button></div><small>首次获取或更换服务器时，请与服务器SSH主机指纹核对；点击检查差异即信任当前指纹。</small></label><label class="field"><span>连接方式</span><select name="authType"><option value="password">SSH密码</option><option value="key">SSH私钥</option></select></label><label class="field" data-password-field><span>SSH密码</span><input name="password" type="password" autocomplete="off" placeholder="不是宝塔面板密码"></label><div data-key-fields hidden><label class="field"><span>私钥文件</span><input name="keyFile" type="file"></label><label class="field"><span>私钥口令（如有）</span><input name="passphrase" type="password" autocomplete="off"></label></div><div class="remote-plan" aria-live="polite"></div><div class="remote-job" aria-live="polite"></div><div class="form-error" hidden></div></div><footer class="modal-foot">${btn('关闭','close-dialog')}<button class="btn" type="submit" data-remote="check">检查差异</button><button class="btn primary" type="button" data-remote="deploy" disabled>部署并清理失效文件</button></footer></form>`);
    const form=document.querySelector('#remote-sync-form'),get=selector=>form.querySelector(selector),error=get('.form-error'),report=get('.remote-plan'),jobNode=get('.remote-job'),deploy=get('[data-remote=deploy]');let plan=null,running=false;
    const showError=value=>{error.hidden=!value;error.textContent=value||'';};
    const currentProfile=()=>Object.fromEntries(['host','port','username','directory','fingerprint'].map(name=>[name,form.elements.namedItem(name).value]));
    async function credentials(){
      if(form.elements.namedItem('authType').value==='password')return{password:form.elements.namedItem('password').value};
      const file=form.elements.namedItem('keyFile').files[0];if(!file?.size)throw new Error('请选择SSH私钥文件。');if(file.size>131072)throw new Error('私钥文件过大。');
      return{privateKey:await file.text(),passphrase:form.elements.namedItem('passphrase').value};
    }
    function busy(value){running=value;form.querySelectorAll('input,select,button:not([data-action=close-dialog])').forEach(node=>node.disabled=value);deploy.disabled=value||!plan;}
    function list(title,names){return names.length?`<details><summary>${title}（${names.length}个）</summary><ul>${names.slice(0,100).map(name=>`<li>${esc(name)}</li>`).join('')}${names.length>100?'<li>仅显示前100个文件</li>':''}</ul></details>`:'';}
    async function watch(job){
      busy(true);
      try{
        while(form.isConnected){
          jobNode.textContent=job.message+(job.totalBytes?` ${sizeLabel(job.uploadedBytes)} / ${sizeLabel(job.totalBytes)}`:'');
          if(job.status!=='running')break;
          await new Promise(resolve=>setTimeout(resolve,700));job=await api('/api/remote/jobs/'+job.id);
        }
        if(job.status==='done'){const result=job.result;jobNode.textContent=`${job.message}。上传${result.uploaded}个，复用${result.unchanged}个，清理${result.deleted}个，上传${sizeLabel(result.uploadBytes)}。`;plan=null;for(const name of ['password','passphrase','keyFile'])form.elements.namedItem(name).value='';}
        if(job.status==='failed')throw new Error(job.message);
      }catch(failure){showError(failure.message);}finally{busy(false);}
    }
    form.addEventListener('input',event=>{if(running)return;plan=null;deploy.disabled=true;report.replaceChildren();if(['host','port','username'].includes(event.target.name))form.elements.namedItem('fingerprint').value='';});
    form.addEventListener('change',()=>{const key=form.elements.namedItem('authType').value==='key';get('[data-key-fields]').hidden=!key;get('[data-password-field]').hidden=key;plan=null;deploy.disabled=true;report.replaceChildren();});
    get('[data-remote=fingerprint]').addEventListener('click',async()=>{
      busy(true);showError('');try{const value=await api('/api/remote/fingerprint','POST',{profile:currentProfile()});form.elements.namedItem('fingerprint').value=value.fingerprint;plan=null;report.textContent='已取得服务器指纹。请核对后检查差异。';}catch(failure){showError(failure.message);}finally{busy(false);}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();event.stopPropagation();busy(true);showError('');plan=null;report.textContent='正在服务器端比对文件内容，不下载图片和视频…';
      try{plan=await api('/api/remote/plan','POST',{profile:currentProfile(),credentials:await credentials(),releaseId});
        report.innerHTML=`<p>上传 ${plan.changed.length} 个文件（${sizeLabel(plan.uploadBytes)}），复用 ${plan.unchanged} 个，清理 ${plan.deleted.length} 个失效文件。</p>${plan.firstSync?'<p>首次接管只管理本次站点文件，之前手动上传的其他文件会保留。</p>':''}${plan.preserved.length?`<p>另有${plan.preserved.length}个旧文件已被外部修改，本次保留。</p>`:''}${plan.hasPrivateSpaces?`<p class="inline-note blue">私密文件将保存在网站目录外。${plan.privateServiceReady?'已检测到私密访问服务。':'首次使用需启用服务器访问服务及Nginx代理，完成后才能分享私密空间。'}<a href="/api/spaces/server-config">下载服务器配置与说明</a></p>`:''}${list('上传或更新',plan.changed)}${list('部署成功后清理',plan.deleted)}`;
      }catch(failure){report.replaceChildren();showError(failure.message);}finally{busy(false);}
    });
    deploy.addEventListener('click',async()=>{
      if(!plan||running)return;showError('');busy(true);
      try{const job=await api('/api/remote/deploy','POST',{planId:plan.id,credentials:await credentials()});await watch(job);}catch(failure){showError(failure.message);}finally{busy(false);}
    });
    if(state.job?.status==='running')watch(state.job);
  }};
})();
