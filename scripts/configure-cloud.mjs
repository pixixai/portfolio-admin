import {writeFile,rename,unlink,lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {emitKeypressEvents} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {adminPasswordHash} from '../lib/cloud-auth.mjs';
import {runtimeMode} from '../lib/runtime-mode.mjs';
export async function writeCloudConfiguration(file,values,{force=false}={}){
 const encode=value=>{value=String(value).replaceAll('\\','/');if(/[\r\n\0'"]/.test(value))throw new Error('配置项不能包含引号或换行。');return "'"+value+"'";};
 const text='# Cloud configuration. Keep this file private.\n'+Object.entries(values).map(([key,value])=>{if(!/^(PORT|PORTFOLIO_[A-Z_]+)$/.test(key))throw new Error('配置项名称不正确。');return key+'='+encode(value);}).join('\n')+'\n';
 if(!force){await writeFile(file,text,{flag:'wx',mode:0o600});return;}
 const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,text,{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function passwordQuestion(label){
 return new Promise((resolve,reject)=>{process.stdout.write(label);emitKeypressEvents(process.stdin);const raw=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();let value='';
  const done=(error)=>{process.stdin.off('keypress',key);process.stdin.setRawMode(raw);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
  const key=(text,info={})=>{if(info.ctrl&&info.name==='c')return done(new Error('已取消，配置未写入。'));if(info.name==='return'||info.name==='enter')return done();if(info.name==='backspace')value=Array.from(value).slice(0,-1).join('');else if(!info.ctrl&&!info.meta&&text&&!/[\x00-\x1f\x7f]/.test(text)&&value.length+text.length<=128)value+=text;};process.stdin.on('keypress',key);
 });
}
async function main(){
 const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),file=path.join(root,'.env.cloud'),force=process.argv.includes('--force');
 if(!process.stdin.isTTY)throw new Error('请在交互终端运行npm run configure:cloud。');
 let previous={};try{await lstat(file);if(!force)throw new Error('.env.cloud已存在；如需重新设置，请加 -- --force。');previous=parseEnv(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const readline=createInterface({input:process.stdin,output:process.stdout}),ask=async(label,fallback='')=>(await readline.question(label+(fallback?' ['+fallback+']':'')+'：')).trim()||fallback;
 const adminOrigin=await ask('后台HTTPS地址，例如https://admin.example.com',previous.PORTFOLIO_ADMIN_ORIGIN||''),siteOrigin=await ask('作品网站HTTPS地址，例如https://example.com',previous.PORTFOLIO_SITE_ORIGIN||''),username=await ask('管理员名称',previous.PORTFOLIO_ADMIN_USER||'admin'),dataDir=await ask('用户数据绝对目录',previous.PORTFOLIO_DATA_DIR||'/var/lib/portfolio-admin/user'),port=await ask('内部服务端口',previous.PORT||'4180');readline.close();if(!/^\d+$/.test(port)||Number(port)<1024||Number(port)>65535)throw new Error('端口需为1024～65535。');
 const password=await passwordQuestion('管理员密码（12～128个字符，输入不显示）：'),confirm=await passwordQuestion('再次输入管理员密码：');if(password!==confirm)throw new Error('两次密码不一致，配置未写入。');const passwordHash=await adminPasswordHash(password);
 const runtime=runtimeMode({root,dataDir,env:{},runtime:{mode:'cloud',adminOrigin,siteOrigin,username,passwordHash,trustProxy:true}});
 await writeCloudConfiguration(file,{PORTFOLIO_MODE:'cloud',PORTFOLIO_ADMIN_ORIGIN:runtime.adminOrigin,PORTFOLIO_SITE_ORIGIN:runtime.siteOrigin,PORTFOLIO_DATA_DIR:runtime.dataDir,PORTFOLIO_ADMIN_USER:username,PORTFOLIO_ADMIN_PASSWORD_HASH:passwordHash,PORTFOLIO_TRUST_PROXY:'true',PORT:port},{force});
 process.stdout.write('已写入.env.cloud（仅保存密码校验值，不保存明文密码）。\n请按云端部署文档配置HTTPS反向代理，再运行npm run start:cloud。\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
