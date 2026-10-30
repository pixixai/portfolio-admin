import {createReadStream} from 'node:fs';
import {readFile,readdir,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ssh2 from 'ssh2';
import {inspectDeployment} from './deployment.mjs';
import {fail} from './validation.mjs';

const helper=fileURLToPath(new URL('../resources/remote-sync.py',import.meta.url));
const {Client}=ssh2;
const defaults={host:'',port:22,username:'root',directory:'/www/wwwroot/pixixai.com',fingerprint:''};
export function remoteProfile(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('请填写服务器连接信息。');
  const host=String(input.host||'').trim(),port=Number(input.port??22),username=String(input.username||'').trim(),directory=String(input.directory||'').replace(/\/$/,'');
  if(!/^[a-z\d][a-z\d.:-]{0,252}$/i.test(host)||!Number.isInteger(port)||port<1||port>65535)fail('服务器地址或SSH端口不正确。');
  if(!/^[a-z_][a-z\d_.-]{0,63}$/i.test(username))fail('SSH用户名不正确。');
  if(!directory.startsWith('/')||directory.length>500||directory.split('/').slice(1).some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||/[\\\x00-\x1f]/.test(directory)||['/www','/www/wwwroot','/home','/var','/var/www','/usr','/etc'].includes(directory))fail('请填写网站专用目录，例如/www/wwwroot/pixixai.com。');
  const fingerprint=input.fingerprint||'';if(fingerprint&&!/^SHA256:[A-Za-z\d+/]{43}$/.test(fingerprint))fail('服务器指纹格式不正确。');
  return{host,port,username,directory,fingerprint};
}
function auth(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('SSH凭据格式不正确。');
  const result={};
  for(const name of ['password','privateKey','passphrase'])if(input[name]){if(typeof input[name]!=='string'||input[name].length>(name==='privateKey'?131072:1024))fail('SSH凭据格式不正确。');result[name]=input[name];}
  if(!result.password&&!result.privateKey)fail('请输入服务器SSH密码，或选择私钥文件。');
  return result;
}
const fingerprint=key=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
export function probeFingerprint(profile){
  return new Promise((resolve,reject)=>{
    const client=new Client();let found=false;
    client.on('error',error=>{if(!found)reject(Object.assign(new Error('无法连接SSH：'+error.message),{status:400}));});
    client.connect({host:profile.host,port:profile.port,username:profile.username,readyTimeout:15000,hostVerifier:key=>{found=true;resolve({fingerprint:fingerprint(key)});setImmediate(()=>client.destroy());return false;}});
  });
}
export async function connectRemote(profile,credentials){
  if(!profile.fingerprint)fail('请先获取并核对服务器SSH指纹。');
  const client=new Client();let mismatch=false;
  await new Promise((resolve,reject)=>{
    client.once('ready',resolve);client.once('error',error=>{client.destroy();reject(Object.assign(new Error(mismatch?'服务器SSH指纹发生变化，请核对后重新配置。':'SSH连接失败：'+error.message),{status:400}));});
    client.connect({host:profile.host,port:profile.port,username:profile.username,...credentials,readyTimeout:20000,keepaliveInterval:10000,keepaliveCountMax:3,hostVerifier:key=>{mismatch=fingerprint(key)!==profile.fingerprint;return !mismatch;}});
  });
  // Error handlers on channels provide actionable failures; prevent unhandled socket errors.
  client.on('error',()=>{});
  const code=(await readFile(helper)).toString('base64');
  const command=`PYTHONIOENCODING=utf-8 python3 -c 'import base64;exec(base64.b64decode("${code}"))'`;
  return{
    rpc(request){return new Promise((resolve,reject)=>client.exec(command,(error,stream)=>{
      if(error)return reject(error);let output='',stderr='';
      const timer=setTimeout(()=>{stream.close();reject(new Error('服务器处理超时，请重新检查线上状态。'));},600000);
      stream.on('data',chunk=>{output+=chunk;if(output.length>20*1024*1024){stream.close();reject(new Error('服务器返回内容超限。'));}});
      stream.stderr.on('data',chunk=>{if(stderr.length<2000)stderr+=chunk;});
      stream.on('error',error=>{clearTimeout(timer);reject(error);});stream.on('close',()=>{
        clearTimeout(timer);try{const response=JSON.parse(output);if(!response.ok)throw new Error(response.error);resolve(response.result);}catch(error){reject(new Error(output?error.message:'服务器未返回部署结果，请确认已安装Python3。'+stderr.slice(0,300)));}
      });stream.end(JSON.stringify(request));
    }));},
    async upload(files,directory,progress){
      if(!files.length)return;
      const sftp=await new Promise((resolve,reject)=>client.sftp((error,value)=>error?reject(error):resolve(value)));
      try{for(const file of files){await new Promise((resolve,reject)=>sftp.fastPut(file.file,path.posix.join(directory,file.name),{concurrency:8,step:transferred=>progress(file.name,transferred)},error=>error?reject(error):resolve()));progress(file.name,file.size);}}finally{sftp.end();}
    },
    close(){client.end();},
  };
}
export async function localManifest(directory){
  const {files,report}=await inspectDeployment(directory);if(report.errors.length)fail(report.errors.join('\n'));
  const privateRoot=path.join(path.dirname(directory),'private');
  try{await access(privateRoot);async function walk(folder,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())fail('私密发布文件不能包含符号链接。');const file=path.join(folder,entry.name),name=prefix+entry.name;if(entry.isDirectory())await walk(file,name+'/');else{const {stat}=await import('node:fs/promises');files.push({name:'_portfolio_private/'+name,file,size:(await stat(file)).size});}}}await walk(privateRoot);}catch(error){if(error.code!=='ENOENT')throw error;}
  const manifest={};
  for(const file of files){const hash=createHash('sha256');for await(const chunk of createReadStream(file.file))hash.update(chunk);manifest[file.name]={size:file.size,hash:hash.digest('hex')};}
  return{files,manifest};
}

export class RemoteSync {
  constructor(store,{connect=connectRemote,probe=probeFingerprint}={}){this.store=store;this.connect=connect;this.probe=probe;this.plans=new Map();this.jobs=new Map();this.busy=false;}
  state(){return{profile:this.store.get('remoteDeployment')||defaults,job:[...this.jobs.values()].at(-1)||null};}
  async inspect(input){
    if(this.busy)fail('正在部署，请完成后再检查差异。',409);
    const profile=remoteProfile(input.profile),credentials=auth(input.credentials),release=this.store.releases().find(item=>item.id===input.releaseId);
    if(!release)fail('请先在本地发布作品，再选择已发布版本部署。',404);
    const {files,manifest}=await localManifest(path.join(this.store.directory,'releases',release.id,'dist'));
    let connection;
    try{
      connection=await this.connect(profile,credentials);
      const report=await connection.rpc({action:'plan',root:profile.directory,files:manifest});
      const id=randomUUID();this.plans.set(id,{id,profile,releaseId:release.id,files,manifest,report,createdAt:Date.now()});
      for(const [key,entry]of this.plans)if(Date.now()-entry.createdAt>1800000)this.plans.delete(key);
      this.store.set('remoteDeployment',profile);
      return{id,releaseId:release.id,...report,hasPrivateSpaces:!!release.snapshot.spaces?.some(space=>space.enabled),privateDirectory:path.posix.join(path.posix.dirname(profile.directory),'.portfolio-spaces',createHash('sha256').update(profile.directory).digest('hex').slice(0,20))};
    }catch(error){error.status ||= 400;throw error;}finally{connection?.close();}
  }
  start(input){
    if(this.busy)fail('正在部署另一个版本，请稍候。',409);
    const plan=this.plans.get(input.planId);if(!plan||Date.now()-plan.createdAt>1800000)fail('差异检查已过期，请重新检查。',409);
    const credentials=auth(input.credentials),job={id:randomUUID(),releaseId:plan.releaseId,status:'running',message:'正在连接服务器…',uploadedBytes:0,totalBytes:plan.report.uploadBytes};
    this.busy=true;this.jobs.set(job.id,job);this.plans.delete(plan.id);
    this.run(job,plan,credentials).finally(()=>{this.busy=false;});return job;
  }
  async run(job,plan,credentials){
    let connection,begun=false,applying=false;
    const request=action=>({action,root:plan.profile.directory,token:job.id});
    try{
      connection=await this.connect(plan.profile,credentials);
      const stage=await connection.rpc({...request('begin'),files:plan.manifest,planHash:plan.report.hash});begun=true;
      const changed=plan.files.filter(file=>plan.report.changed.includes(file.name)),completed=new Map();
      job.message=`正在上传变化文件：${changed.length}个`;
      await connection.upload(changed,stage.uploadDirectory,(name,bytes)=>{completed.set(name,bytes);job.uploadedBytes=[...completed.values()].reduce((sum,value)=>sum+value,0);job.currentFile=name;});
      job.message='上传完成，正在校验、更新并清理失效文件…';applying=true;
      job.result=await connection.rpc(request('apply'));job.status='done';job.message=job.result.cleanupPending?'部署成功，部分临时文件将在下次连接时清理':'部署成功，失效文件已清理';
    }catch(error){
      // A dropped connection after apply may mean the server already committed.
      if(applying){try{connection?.close();connection=await this.connect(plan.profile,credentials);const result=await connection.rpc(request('status'));if(result.status==='done'){job.result=result;job.status='done';job.message='部署成功，已重新确认服务器结果';return;}}catch{}}
      if(begun&&!applying)try{await connection.rpc(request('abort'));}catch{}
      job.status='failed';job.message=applying?'部署结果未确认或已回退，请重新检查差异。'+error.message:'部署未完成，线上网站未变更。'+error.message;
    }finally{connection?.close();for(const key of Object.keys(credentials))credentials[key]='';}
  }
}
