import path from 'node:path';
import {readdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';
const cache = new Map();
const skip = new Set(['.git','.vscode','node_modules','target','.cache','Drivers','Middlewares']);
function isElf(file) {
  let fd;
  try { fd=openSync(file,'r'); const header=Buffer.alloc(4); return readSync(fd,header,0,4,0)===4 && header.equals(Buffer.from([127,69,76,70])); }
  catch {return false;} finally {if(fd!==undefined)closeSync(fd);}
}
export function detectProjectTarget(root, refresh=false, preferredBuildDir=null) {
  if (!root) return {chip:'',elf:'',candidates:[],sources:[]};
  if (!refresh && cache.has(root)) return cache.get(root);
  const files=[],cmake=[],scripts=[],sources=[],chips=new Set(),names=new Set(),references=new Set(); let visited=0;
  function walk(dir,depth=0) {
    if(depth>8 || visited>12000)return;
    let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){if(++visited>12000)break;if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);
      if(entry.isDirectory()){if(!skip.has(entry.name))walk(file,depth+1);}
      else if(/\.elf$/i.test(entry.name) && isElf(file))files.push(file);
      else if(!path.relative(root,file).split(path.sep).includes('build')) {
        if(entry.name==='CMakeLists.txt' || entry.name.endsWith('.cmake'))cmake.push(file);
        else if(entry.name.endsWith('.ld'))scripts.push(file);
      }
    }
  }
  walk(root);
  const variables={};
  const texts=cmake.map(file=>({file,text:readFileSync(file,'utf8').replace(/#[^\r\n]*/g,'')}));
  for(const {text} of texts)for(const match of text.matchAll(/\bset\s*\(\s*(\w+)\s+"?([\w.-]+)"?\s*\)/gi))variables[match[1]]=match[2];
  for(const {file,text} of texts){
    const expanded=text.replace(/\$\{(\w+)\}/g,(all,key)=>variables[key] || all);
    for(const match of expanded.matchAll(/\badd_executable\s*\(\s*"?([\w.-]+)/gi)){names.add(match[1]);sources.push(path.relative(root,file));}
    for(const match of expanded.matchAll(/([\w.-]+\.ld)\b/g))references.add(match[1]);
    for(const match of expanded.matchAll(/\bSTM32[A-Z]\d{3}[A-WYZ][A-Z0-9](?=[A-Z0-9]*\b)/g))chips.add(match[0]);
  }
  // Prefer scripts referenced by the build. Generic memory regions alone do not identify a chip.
  const linked=references.size?scripts.filter(file=>references.has(path.basename(file))):scripts.length===1?scripts:[];
  for(const file of linked){
    const text=path.basename(file)+'\n'+readFileSync(file,'utf8');
    for(const match of text.matchAll(/\bSTM32[A-Z]\d{3}[A-WYZ][A-Z0-9](?=[A-Z0-9a-z_]*\b)/g))chips.add(match[0]);
    sources.push(path.relative(root,file));
  }
  const currentFiles=files.filter(file=>!path.relative(root,file).replaceAll('\\','/').startsWith('build/pnx-platform/'));
  const matching=currentFiles.filter(file=>names.has(path.basename(file,'.elf')));
  const candidates=(names.size?matching:currentFiles).map(elf=>({elf,source:'CMake target / ELF',chip:chips.size===1?[...chips][0]:''}));
  const built = preferredBuildDir ? candidates.filter(item => path.dirname(item.elf) === path.resolve(preferredBuildDir)) : [];
  const chosen = built.length === 1 ? built[0] : candidates.length === 1 ? candidates[0] : null;
  const result={chip:chips.size===1?[...chips][0]:'',elf:chosen?.elf || '',candidates,sources:[...new Set(sources)],ambiguous:!chosen && candidates.length>1};
  cache.set(root,result);return result;
}
