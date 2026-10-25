import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLocalRequest} from '../lib/local-access.mjs';

const request=(overrides={})=>({method:'GET',headers:{host:'127.0.0.1:4180',...overrides.headers},socket:{remoteAddress:'127.0.0.1',localPort:4180,...overrides.socket},...Object.fromEntries(Object.entries(overrides).filter(([key])=>!['headers','socket'].includes(key)))});
const rejected=(value,route='/api/state')=>assert.throws(()=>validateLocalRequest(value,route),error=>error.status===403);
test('无账号后台仅允许本机连接及可信本机地址，拒绝域名重绑定和伪造访问地址',()=>{
  for(const host of ['127.0.0.1:4180','localhost:4180','[::1]:4180'])assert.doesNotThrow(()=>validateLocalRequest(request({headers:{host}}),'/api/state'));
  for(const remoteAddress of ['::1','::ffff:127.0.0.1'])assert.doesNotThrow(()=>validateLocalRequest(request({socket:{remoteAddress}}),'/api/state'));
  for(const host of ['evil.invalid:4180','127.0.0.1.evil.invalid:4180','127.0.0.1:4181','localhost:4180/path','user@localhost:4180','localhost:4180?x=1','localhost:4180#fragment',undefined])rejected(request({headers:{host}}));
  rejected(request({socket:{remoteAddress:'192.168.1.10'}}));rejected(request({socket:{remoteAddress:'8.8.8.8'}}));
});
test('无账号后台保护读写接口、预览和历史；正常本机页面与导出不依赖Cookie',()=>{
  for(const route of ['/api/state','/api/export/v-one','/preview/v-one/','/history/v-one/']){
    assert.doesNotThrow(()=>validateLocalRequest(request(),route));
    assert.doesNotThrow(()=>validateLocalRequest(request({headers:{origin:'http://127.0.0.1:4180','sec-fetch-site':'same-origin'}}),route));
    rejected(request({headers:{origin:'http://evil.invalid'}}),route);
    rejected(request({headers:{origin:'http://127.0.0.1:9999'}}),route);
    rejected(request({headers:{'sec-fetch-site':'cross-site'}}),route);
  }
  assert.doesNotThrow(()=>validateLocalRequest(request({headers:{'sec-fetch-site':'cross-site'}}),'/'));
  for(const method of ['POST','PUT','DELETE'])rejected(request({method,headers:{origin:'null'}}),'/api/projects');
});
