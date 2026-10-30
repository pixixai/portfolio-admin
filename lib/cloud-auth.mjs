import {randomBytes,scrypt as derive,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {isIP} from 'node:net';
const scrypt=promisify(derive),cookie='__Host-portfolio-admin',ttl=8*3600*1000;
const pattern=/^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const validAdminPasswordHash=value=>typeof value==='string'&&pattern.test(value);
export async function adminPasswordHash(password){
 if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('管理员密码需为12～128个字符。');
 const salt=randomBytes(16).toString('hex'),hash=await scrypt(password,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:3,maxmem:64*1024**2});return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}
export function loginPage(error='',username='admin'){
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 作品管理</title><link rel="stylesheet" href="/login.css"></head><body><main><span class="login-mark" aria-hidden="true"></span><h1>登录作品管理</h1><p>管理你的作品、素材和分享空间。</p><form action="/auth/login" method="post"><label>管理员<input name="username" autocomplete="username" maxlength="40" value="${escape(username)}" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><p class="login-error" role="alert">${escape(error)}</p><button type="submit">登录</button></form></main></body></html>`;
}
export function cloudAuth(runtime,{now=Date.now}={}){
 const sessions=new Map(),attempts=new Map();let deriving=0;
 function token(request){const values=(request.headers.cookie||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(cookie+'='));return values.length===1?values[0].slice(cookie.length+1):'';}
 function authenticated(request){const raw=token(request);if(!/^[a-f0-9]{64}$/.test(raw))return false;const key=sha(raw),expiry=sessions.get(key);if(!expiry||expiry<=now()){sessions.delete(key);return false;}return true;}
 function clearCookie(response){response.setHeader('Set-Cookie',`${cookie}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);}
 return{authenticated,logout(request,response){sessions.delete(sha(token(request)));clearCookie(response);},async login(request,response,username,password){
  const time=now();for(const [key,value]of attempts)if(time-value.started>=15*60000)attempts.delete(key);for(const[key,expiry]of sessions)if(expiry<=time)sessions.delete(key);
  const forwarded=String(request.headers['x-real-ip']||''),ip=runtime.trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)&&isIP(forwarded)?forwarded:request.socket.remoteAddress,key=String(ip),attempt=attempts.get(key)||{started:time,count:0};
  if(attempt.count>=8||deriving>=2||attempts.size>=2000){response.setHeader('Retry-After','900');return{status:429,error:'尝试次数过多，请15分钟后重试。'};}
  attempt.count++;attempts.set(key,attempt);let valid=false;
  if(typeof username==='string'&&typeof password==='string'&&username.length<=40&&password.length>0&&password.length<=128){const [,salt,expected]=pattern.exec(runtime.passwordHash);deriving++;try{const actual=await scrypt(password,Buffer.from(salt,'hex'),32,{N:32768,r:8,p:3,maxmem:64*1024**2});valid=timingSafeEqual(actual,Buffer.from(expected,'hex'))&&timingSafeEqual(Buffer.from(sha(username)),Buffer.from(sha(runtime.username)));}finally{deriving--;}}
  if(!valid)return{status:401,error:'管理员名称或密码不正确。'};
  attempts.delete(key);const raw=randomBytes(32).toString('hex');sessions.delete(sha(token(request)));if(sessions.size>=32)sessions.delete(sessions.keys().next().value);sessions.set(sha(raw),time+ttl);
  response.setHeader('Set-Cookie',`${cookie}=${raw}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl/1000}`);return{status:200};
 }};
}
