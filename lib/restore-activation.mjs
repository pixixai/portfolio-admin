import {readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export const restoreJournalPath=directory=>path.join(path.dirname(path.resolve(directory)),'.portfolio-user-switch-'+createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0,16)+'.json');
const exists=async file=>{try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function validate(record,directory){
  const parent=path.dirname(directory);
  if(record?.format!=='portfolio-user-switch'||record.directory!==directory||path.dirname(record.stage)!==parent||!/^\.portfolio-user-restore-[a-f\d-]{36}$/.test(path.basename(record.stage))||path.dirname(record.previous)!==parent||!/^\.portfolio-user-before-restore-\d+-[a-f\d-]{8}$/.test(path.basename(record.previous)))throw new Error('用户数据恢复记录路径不正确，请检查后重试。');
}
async function checkDirectories(record){for(const file of [record.directory,record.stage,record.previous])if(await exists(file)){const info=await lstat(file);if(!info.isDirectory()||info.isSymbolicLink()||path.dirname(await realpath(file))!==path.dirname(record.directory))throw new Error('用户数据恢复路径类型异常，未移动数据。');}}
async function writeJournal(file,record,create=false){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(record),{flag:'wx'});if(create&&await exists(file))throw new Error('已有未完成的恢复记录，请重启后台先恢复。');await rename(temporary,file);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export async function recoverUserData(directory){
  directory=path.resolve(directory);const file=restoreJournalPath(directory);let record;try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  validate(record,directory);await checkDirectories(record);
  const current=await exists(directory),previous=await exists(record.previous),staged=await exists(record.stage);
  if(record.phase==='committed'){if(!current)throw new Error('恢复后的用户目录缺失，已保留原数据副本，请先检查。');}
  else if(previous){
    if(current){if(staged)throw new Error('发现多份待恢复用户数据，请先保留并检查，未自动覆盖。');await rename(directory,record.stage);}
    await rename(record.previous,directory);
  }else if(!current)throw new Error('用户数据切换未完成，目录缺失，未初始化空白数据。');
  await unlink(file);
}
export async function activateUserData(directory,stage,{close,reopen}){
  directory=path.resolve(directory);stage=path.resolve(stage);const file=restoreJournalPath(directory),record={format:'portfolio-user-switch',directory,stage,previous:path.join(path.dirname(directory),'.portfolio-user-before-restore-'+Date.now()+'-'+randomUUID().slice(0,8)),phase:'prepared'};
  validate(record,directory);await checkDirectories(record);await writeJournal(file,record,true);
  close();let moved=false,enabled=false;
  try{
    await rename(directory,record.previous);moved=true;await rename(stage,directory);enabled=true;await reopen();
    record.phase='committed';await writeJournal(file,record);await unlink(file);return record.previous;
  }catch(error){
    try{if(enabled){try{close();}catch{}await rename(directory,stage);}if(moved)await rename(record.previous,directory);await reopen();await unlink(file);}catch{throw new Error('恢复未完成，原始数据仍保留在'+record.previous+'，下次启动将尝试恢复。');}
    throw error;
  }
}
