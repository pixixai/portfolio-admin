import {fail} from './validation.mjs';

// Host validation also keeps a remote hostname resolving to loopback from
// becoming a same-origin route into this local, account-free application.
export function validateLocalRequest(request,pathname) {
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress))fail('后台仅允许本机访问。',403);
  if(['x-forwarded-proto','x-forwarded-host','x-forwarded-for','x-real-ip','forwarded'].some(name=>Object.hasOwn(request.headers,name)))fail('本地模式不接受代理访问，请使用云端模式。',403);
  let address;
  try{address=new URL('http://'+request.headers.host);}catch{fail('本机访问地址不正确。',403);}
  if(!['127.0.0.1','localhost','[::1]'].includes(address.hostname)||address.username||address.password||address.pathname!=='/'||address.search||address.hash||address.host!==request.headers.host.toLowerCase()||Number(address.port||80)!==request.socket.localPort)fail('请使用本机后台地址访问。',403);
  const protectedPath=/^\/(api|preview|draft|history)(\/|$)/.test(pathname);
  if(protectedPath||!['GET','HEAD'].includes(request.method)){
    if(request.headers['sec-fetch-site']==='cross-site'||request.headers.origin&&request.headers.origin!==address.origin)fail('请求来源不正确。',403);
  }
}
