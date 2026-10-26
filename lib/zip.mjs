import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {fail} from './validation.mjs';
const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
export function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
export const packageLimit=512*1024*1024;
export function readZip(bytes) {
  const invalid=()=>fail('部署包损坏、格式不支持或超出容量限制。');
  if(bytes.length<22||bytes.length>packageLimit)invalid();
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))invalid();
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(count>20000||count!==bytes.readUInt16LE(end+8)||start+size!==end)invalid();
  const entries=new Map(),names=new Set();let cursor=start,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)invalid();
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),packed=bytes.readUInt32LE(cursor+20),length=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    const attributes=bytes.readUInt32LE(cursor+38),name=bytes.toString('utf8',cursor+46,cursor+46+nameLength);cursor+=46+nameLength+extra+comment;
    if(cursor>end||!name||name.length>1000||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(part=>part==='.'||part==='..')||names.has(name.toLowerCase())||flags&1||![0,8].includes(method)||((attributes>>>16)&0xf000)===0xa000)invalid();
    names.add(name.toLowerCase());total+=length;if(total>packageLimit||offset+30>start||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt16LE(offset+6)&1)invalid();
    const localNameLength=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),data=offset+30+localNameLength+localExtra;
    if(bytes.toString('utf8',offset+30,offset+30+localNameLength)!==name||data+packed>start)invalid();
    if(name.endsWith('/')){if(length)invalid();continue;}
    entries.set(name,{length,read(){let output;try{output=method===0?bytes.subarray(data,data+packed):inflateRawSync(bytes.subarray(data,data+packed),{maxOutputLength:Math.max(1,length)});}catch{invalid();}if(output.length!==length||crc32(output)!==crc)invalid();return output;}});
  }
  if(cursor!==end)invalid();return entries;
}
export async function zipDirectory(root) {
  const files = [];
  async function walk(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { if (['.preview', 'node_modules'].includes(entry.name)) continue; const file = path.join(folder, entry.name); if (entry.isDirectory()) await walk(file); else files.push(file); } }
  await walk(root);
  const entries=[];for(const file of files)entries.push({name:path.relative(root,file).split(path.sep).join('/'),bytes:await readFile(file)});
  return zipEntries(entries);
}
export function zipEntries(entries) {
  if(entries.length>65535)fail('ZIP文件数量超出支持范围。');
  const chunks = [], directory = []; let offset = 0;
  const names=new Set();
  for (const entry of entries) {
    if(typeof entry.name!=='string'||!entry.name||entry.name.startsWith('/')||/[\\:\x00-\x1f]/.test(entry.name)||entry.name.split('/').some(part=>!part||part==='.'||part==='..')||names.has(entry.name.toLowerCase()))fail('ZIP文件名不正确或重复。');names.add(entry.name.toLowerCase());
    const name = Buffer.from(entry.name),bytes=Buffer.isBuffer(entry.bytes)?entry.bytes:Buffer.from(entry.bytes),crc=crc32(bytes);
    if(name.length>65535||bytes.length>0xffffffff||offset+bytes.length+30+name.length>0xffffffff)fail('ZIP容量超出支持范围。');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(header, name, bytes); directory.push(central, name); offset += header.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
