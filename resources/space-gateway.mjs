// Standalone, dependency-free visitor gateway. Bind to loopback behind HTTPS Nginx.
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {randomBytes,createHmac,createHash,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scrypt=promisify(derive),ids=/^s-[a-f0-9]{24}$/,escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mime={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.woff2':'font/woff2','.woff':'font/woff','.ico':'image/x-icon'};
const equal=(a,b)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function screen(error='',locked=false,publicUrl='/',work='',pin=false){return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>分享空间</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f5f6f8;font:16px system-ui,sans-serif;color:#18202c}main{width:min(360px,calc(100vw - 80px));padding:32px;background:white;box-shadow:0 8px 35px #18202c0d}h1{font-size:24px;margin:0 0 12px}p{line-height:1.7;color:#657084}input,button{box-sizing:border-box;width:100%;padding:13px;border:1px solid #d6dce5;border-radius:0;font:inherit}button{margin-top:14px;border:0;background:#171b22;color:white;cursor:pointer}.error{color:#b43434;min-height:1.7em}a{color:#526480}</style></head><body><main><h1>分享空间</h1><p>${locked?'访问暂时受限，请稍后重试。':'请输入收到的访问码，查看分享给你的作品。'}</p><form action="unlock${work?'?work='+encodeURIComponent(work):''}" method="post"><label>访问码<input name="code" type="password" autocomplete="current-password" required ${pin?'inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" placeholder="4位数字"':'minlength="6" maxlength="128"'} autofocus ${locked?'disabled':''}></label><button ${locked?'disabled':''}>进入空间</button><p class="error" role="alert">${escape(error)}</p></form><a href="${escape(publicUrl)}">浏览公开作品</a></main></body></html>`;}
function reply(response,status,body,type='text/html; charset=utf-8'){const bytes=Buffer.from(body);response.writeHead(status,{'Content-Type':type,'Content-Length':bytes.length});response.end(bytes);return true;}
function headers(response){response.setHeader('Cache-Control','private, no-store, max-age=0');response.setHeader('Pragma','no-cache');response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','same-origin');response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");}
async function safeFile(base,name){
  if(!name||name.length>600||/[\\\x00-\x1f]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new Error('invalid path');
  let file=base;const actual=await realpath(base);for(const part of name.split('/')){file=path.join(file,part);if((await lstat(file)).isSymbolicLink())throw new Error('symlink');}
  if(!(await realpath(file)).startsWith(actual+path.sep)||!(await lstat(file)).isFile())throw new Error('invalid file');return file;
}
export function createSpaceGateway({directory,mount='/space',secure=false,secret=randomBytes(32),trustProxy=false,publicDirectory=null}){
  const attempts=new Map();let deriving=0,cached=null;
  async function loadCatalog(folder){const file=path.join(folder,'catalog.json'),info=await lstat(file);if(info.isSymbolicLink()||info.size>30*1024**2)throw new Error('Invalid space catalog');const key=[file,info.ino,info.mtimeMs,info.ctimeMs,info.size].join(':');if(cached?.key===key)return cached.data;const data=JSON.parse(await readFile(file,'utf8'));if(data.format!=='portfolio-private-spaces'||data.version!==1||!Array.isArray(data.spaces))throw new Error('Invalid space catalog');cached={key,data};return data;}
  const sign=(value,space)=>createHmac('sha256',secret).update(space.access.hash).update(space.accessVersion||'').update(value).digest('base64url');
  function cookieName(space){return(secure?'__Secure-':'')+'portfolio-'+space.id;}
  function authorised(request,space){
    const value=request.headers.cookie?.split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName(space)+'='))?.slice(cookieName(space).length+1)||'';
    const [id,expiry,nonce,signature,...extra]=value.split('.');if(extra.length||id!==space.id||!/^\d{13}$/.test(expiry)||Number(expiry)<Date.now()||Number(expiry)>Date.now()+8*3600000+10000||!/^[a-f0-9]{24}$/.test(nonce||'')||!signature)return false;
    return equal(signature,sign([id,expiry,nonce].join('.'),space));
  }
  return async function handle(request,response){
    let pathname,requestedWork='';try{const address=new URL(request.url,'http://localhost');pathname=decodeURIComponent(address.pathname);const value=address.searchParams.get('work')||'';if(/^[a-z][a-z0-9-]{0,100}$/.test(value))requestedWork=value;}catch{return false;}
    const privateRequest=pathname.startsWith(mount+'/')||pathname===mount;
    if(!privateRequest&&!publicDirectory)return false;
    headers(response);
    try{
      const folder=typeof directory==='function'?await directory():directory;
      if(!privateRequest){
        const catalog=await loadCatalog(folder),name=pathname==='/'?'index.html':pathname.slice(1).endsWith('/')?pathname.slice(1)+'index.html':pathname.slice(1);
        if(!['GET','HEAD'].includes(request.method))return reply(response,405,'不支持此操作。');
        if(!Object.hasOwn(catalog.publicFiles||{},name))return reply(response,404,'页面不存在。');
        response.removeHeader('X-Robots-Tag');response.setHeader('Cache-Control','public, max-age=0, must-revalidate');
        return await serveFile(request,response,await safeFile(typeof publicDirectory==='function'?await publicDirectory(folder):publicDirectory,name));
      }
      const parts=pathname.slice(mount.length+1).split('/'),id=parts.shift();if(!ids.test(id||''))return reply(response,404,'空间不存在。');
      const catalog=await loadCatalog(folder);
      const space=catalog.spaces?.find(item=>item.id===id&&item.enabled);if(!space)return reply(response,404,'空间不存在或已关闭。');
      const login=(message='',locked=false)=>screen(message,locked,mount.slice(0,-6)+'/',requestedWork,space.access?.codeLength===4);
      if(!pathname.startsWith(mount+'/'+id+'/')){response.writeHead(302,{Location:mount+'/'+id+'/'}).end();return true;}
      if(space.accessMode!=='public'&&secure&&(!trustProxy||request.headers['x-forwarded-proto']!=='https'))return reply(response,403,'请通过HTTPS访问分享空间。');
      const action=parts.join('/'),cookiePath=mount+'/'+id+'/';
      if(request.method==='POST'&&['unlock','logout'].includes(action)){
        const expected=(secure?'https://':'http://')+request.headers.host;
        if(request.headers.origin!==expected)return reply(response,403,'请求来源不正确。');
        if(space.accessMode==='public'){response.writeHead(303,{Location:cookiePath}).end();return true;}
        if(action==='logout'){response.setHeader('Set-Cookie',`${cookieName(space)}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);response.writeHead(303,{Location:cookiePath}).end();return true;}
        // Nginx overwrites this header; direct loopback usage uses the actual peer.
        const ip=trustProxy?String(request.headers['x-real-ip']||request.socket.remoteAddress).slice(0,80):request.socket.remoteAddress;
        const key=ip+':'+id,time=Date.now();for(const [k,v]of attempts)if(time-v.started>300000)attempts.delete(k);
        const attempt=attempts.get(key)||{started:time,count:0};if(attempt.count>=10||deriving>=4||attempts.size>=10000){response.setHeader('Retry-After','300');return reply(response,429,login('尝试次数过多，请5分钟后再试。',true));}
        attempt.count++;attempts.set(key,attempt);let size=0,body='';
        if(Number(request.headers['content-length']||0)>2048)return reply(response,413,'请求过大。');
        for await(const chunk of request){size+=chunk.length;if(size>2048)return reply(response,413,'请求过大。');body+=chunk.toString('utf8');}
        if(!String(request.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return reply(response,415,'请求格式不正确。');
        const code=new URLSearchParams(body).get('code')||'';let matches=false;
        if(space.access?.codeLength===4?/^[0-9]{4}$/.test(code):code.length>=6&&code.length<=128){deriving++;try{const hash=await scrypt(code,Buffer.from(space.access.salt,'hex'),32,{N:32768,r:8,p:3,maxmem:64*1024**2});matches=equal(hash.toString('hex'),space.access.hash);}finally{deriving--;}}
        if(!matches)return reply(response,401,login('访问码不正确，请重试。'));
        attempts.delete(key);const value=[id,Date.now()+8*3600000,randomBytes(12).toString('hex')].join('.');
        response.setHeader('Set-Cookie',`${cookieName(space)}=${value}.${sign(value,space)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=28800${secure?'; Secure':''}`);
        response.writeHead(303,{Location:cookiePath+(requestedWork?'?work='+encodeURIComponent(requestedWork):'')}).end();return true;
      }
      if(!['GET','HEAD'].includes(request.method))return reply(response,405,'不支持此操作。');
      if(space.accessMode!=='public'&&!authorised(request,space))return reply(response,action?401:200,action?'请先输入访问码。':login());
      const name=action.endsWith('/')?action+'index.html':action||'index.html';
      if(!Object.hasOwn(space.files||{},name))return reply(response,404,'文件不存在。');
      return await serveFile(request,response,await safeFile(path.join(folder,'spaces',id),name));
    }catch(error){if(response.headersSent)response.destroy();else reply(response,['ENOENT','ENOTDIR'].includes(error.code)?404:503,'分享空间暂不可用，请稍后重试。');return true;}
  };
}
async function serveFile(request,response,file){
      const info=await lstat(file);let start=0,end=info.size-1,status=200;
      if(request.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);if(!match||!match[1]&&!match[2]){response.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();return true;}if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}else start=Math.max(0,info.size-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=info.size){response.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();return true;}status=206;}
      response.writeHead(status,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{})});
      if(request.method==='HEAD'||!info.size){response.end();return true;}const stream=createReadStream(file,{start,end});stream.on('error',()=>response.destroy());response.on('close',()=>stream.destroy());stream.pipe(response);return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORTFOLIO_SPACE_PORT||4181),publicDirectory=process.env.PORTFOLIO_PUBLIC_ROOT;
  if(!publicDirectory||!path.isAbsolute(publicDirectory))throw new Error('Set PORTFOLIO_PUBLIC_ROOT to the public website directory');
  const handle=createSpaceGateway({directory,secure:true,trustProxy:true,publicDirectory});
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid private gateway port');
  const server=http.createServer(async(request,response)=>{if(request.url==='/__portfolio_space_health'&&request.headers['x-portfolio-health']==='1'){headers(response);return reply(response,200,JSON.stringify({format:'portfolio-space-gateway',site:createHash('sha256').update(publicDirectory).digest('hex').slice(0,20)}),'application/json');}if(!await handle(request,response)){headers(response);reply(response,404,'页面不存在。');}});server.requestTimeout=15000;server.headersTimeout=10000;server.maxRequestsPerSocket=1000;
  server.listen(port,'127.0.0.1',()=>console.log('私密访问服务已启动：127.0.0.1:'+port));
}
