import path from 'node:path';
import {validAdminPasswordHash} from './cloud-auth.mjs';
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
export const isLoopback=address=>loopback.has(address);
function origin(value,name){
 let url;try{url=new URL(value);}catch{throw new Error(`请配置${name}，例如https://admin.example.com。`);}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value!==url.origin)throw new Error(`${name}必须为不带路径的HTTPS地址。`);
 return url.origin;
}
export function runtimeMode({root,dataDir,env=process.env,runtime={}}){
 const mode=runtime.mode??env.PORTFOLIO_MODE??'local';if(!['local','cloud'].includes(mode))throw new Error('PORTFOLIO_MODE只能为local或cloud。');
 if(mode==='local')return{mode};
 const adminOrigin=origin(runtime.adminOrigin??env.PORTFOLIO_ADMIN_ORIGIN,'后台地址'),siteOrigin=origin(runtime.siteOrigin??env.PORTFOLIO_SITE_ORIGIN,'作品站地址');
 if(new URL(adminOrigin).hostname===new URL(siteOrigin).hostname)throw new Error('后台和作品站必须使用不同的域名。');
 const passwordHash=runtime.passwordHash??env.PORTFOLIO_ADMIN_PASSWORD_HASH;
 if(!validAdminPasswordHash(passwordHash))throw new Error('请先运行npm run configure:cloud设置管理员密码。');
 const username=runtime.username??env.PORTFOLIO_ADMIN_USER??'admin';if(!/^[a-zA-Z0-9_.-]{1,40}$/.test(username))throw new Error('管理员名称需为1～40个英文字母、数字、下划线、点或横线。');
 const directory=dataDir??env.PORTFOLIO_DATA_DIR;if(!directory||!path.isAbsolute(directory))throw new Error('云端必须配置独立用户目录PORTFOLIO_DATA_DIR的绝对路径。');
 const resolved=path.resolve(directory),project=path.resolve(root);
 if(resolved===path.parse(resolved).root||resolved===project||project.startsWith(resolved+path.sep)||['public','renderer','node_modules','.git'].some(name=>resolved===path.join(project,name)||resolved.startsWith(path.join(project,name)+path.sep)))throw new Error('云端用户目录不能是程序根目录、其上级目录或公开文件目录。');
 const trustProxy=runtime.trustProxy??env.PORTFOLIO_TRUST_PROXY==='true';if(typeof trustProxy!=='boolean')throw new Error('代理配置不正确。');
 return{mode,adminOrigin,siteOrigin,username,passwordHash,trustProxy,dataDir:resolved};
}
export function validateCloudRequest(request,runtime){
 const host=request.headers.host,role=host===new URL(runtime.adminOrigin).host?'admin':host===new URL(runtime.siteOrigin).host?'site':null;
 if(!role)throw Object.assign(new Error('访问域名不正确。'),{status:403});
 const secure=!!request.socket.encrypted||runtime.trustProxy&&isLoopback(request.socket.remoteAddress)&&request.headers['x-forwarded-proto']==='https';
 if(!secure)throw Object.assign(new Error('请通过配置的HTTPS域名访问。'),{status:403});
 const expected=role==='admin'?runtime.adminOrigin:runtime.siteOrigin;
 if(request.headers.origin&&request.headers.origin!==expected||!['GET','HEAD'].includes(request.method)&&request.headers.origin!==expected||role==='admin'&&/^\/(api|preview|draft|history)(\/|$)/.test(new URL(request.url,'http://localhost').pathname)&&request.headers['sec-fetch-site']==='cross-site')throw Object.assign(new Error('请求来源不正确。'),{status:403});
 return role;
}
