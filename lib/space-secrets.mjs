import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export const validSpaceCodeKey=key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key);
export const validSpaceCodeSecret=value=>value&&typeof value==='object'&&/^[a-f0-9]{24}$/.test(value.iv)&&/^[a-f0-9]{32}$/.test(value.tag)&&typeof value.data==='string'&&/^(?:[a-f0-9]{2}){4,512}$/.test(value.data);
export function encryptSpaceCode(code,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),data=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);
  return{iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')};
}
export function decryptSpaceCode(space,key){
  if(!validSpaceCodeKey(key)||!validSpaceCodeSecret(space.displayCode))return null;
  try{const value=space.displayCode,decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(value.iv,'hex'));decipher.setAuthTag(Buffer.from(value.tag,'hex'));return Buffer.concat([decipher.update(Buffer.from(value.data,'hex')),decipher.final()]).toString('utf8');}catch{return null;}
}
