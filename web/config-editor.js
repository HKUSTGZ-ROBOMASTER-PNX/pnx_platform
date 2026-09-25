const vscode=acquireVsCodeApi();let state;const folded=vscode.getState()?.folded||{};const $=id=>document.getElementById(id);const send=(type,extra={})=>vscode.postMessage({type,version:state?.version,...extra});
function el(tag,text,parent){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(parent)parent.append(node);return node;}
function button(text,fn,parent){const b=el('button',text,parent);b.type='button';b.onclick=fn;return b;}
function valueAt(data,path){return path.reduce((v,k)=>v?.[k],data);}
function input(field,value,parent,commit){
 if(field.path?.join('.')==='remoter.source'&&['off','disabled'].includes(value))value='none';
 const choices=field.resource?[...(field.choices||[]),...(state.context?.hardware[field.resource]||[])]:field.choices;
 let node;
 if(choices){node=el('select',undefined,parent);if(value===undefined||!choices.includes(value)){const o=el('option',value===undefined?'未设置':`${value}（当前不可用 / 未知）`,node);o.value=value??'';o.selected=true;}
 for(const c of choices){const o=el('option',c,node);o.value=c;o.selected=c===value;}node.onchange=()=>commit(node.value);
 if(field.resource){const search=el('input',undefined,parent);search.type='search';search.placeholder='Search '+field.resource;search.setAttribute('aria-label','Search '+field.resource);search.disabled=!state.fresh||!state.trusted;search.oninput=()=>{for(const option of node.options)option.hidden=!option.textContent.toLowerCase().includes(search.value.toLowerCase());};} 
 }else{node=el('input',undefined,parent);node.type=field.type==='boolean'?'checkbox':field.type==='number'?'number':'text';if(node.type==='checkbox'){node.checked=value===true;node.onchange=()=>commit(node.checked);}else{node.value=value??'';if(field.type==='number'){node.step=field.integer?'1':'any';if(field.min!==undefined)node.min=field.min;if(field.max!==undefined)node.max=field.max;}
 const submit=()=>{if(node.value===''&&field.type==='number')return;const next=field.type==='number'?Number(node.value):node.value;if(next!==value)commit(next);};node.onblur=submit;node.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();node.blur();}};}}
 node.disabled=!state.trusted||Boolean(field.resource&&!state.fresh);return node;
}
function motorForm(index){const version=state.version;const list=state.data?.devices?.motors?.list||[];const draft=index===undefined?{}:{...list[index]};const dialog=el('dialog',undefined,document.body);el('h2',index===undefined?'新增电机':'修改电机',dialog);el('p','型号与控制模式分别遵循 CMake 枚举；驱动支持及总线帧类型由 Configure 最终检查。',dialog);
 let modeSelect;
 const refreshModes=()=>{if(!modeSelect)return;const selected=draft.control_mode;modeSelect.replaceChildren();const choices=state.modeMap[draft.model]||[];if(!selected||!choices.includes(selected)){const o=el('option',selected?selected+' (unsupported)':'Default: relax',modeSelect);o.value=selected||'';}for(const c of choices){const o=el('option',c,modeSelect);o.value=c;o.selected=c===selected;}};
 for(const field of state.motorFields){const key=field.path[0];const label=el('label',String(key),dialog);const control=input(field,draft[key],label,v=>{draft[key]=v;if(key==='model')refreshModes();});if(key==='control_mode')modeSelect=control;}refreshModes();
 button('取消',()=>dialog.close(),dialog);button('应用',()=>{send(index===undefined?'addMotor':'editMotor',{index,value:draft,version});dialog.close();},dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
}
function moduleGroup(key,title){const group=el('details',undefined,$('content'));group.className='module';group.dataset.viewKey='module:'+key;const id=(state.role||'hardware')+':'+key;group.open=!folded[id];el('summary',title,group);group.ontoggle=()=>{folded[id]=!group.open;vscode.setState({folded});};return group;}
function addField(){const version=state.version;const dialog=el('dialog',undefined,document.body);el('h2','Add field',dialog);el('p','Unknown fields are preserved. Firmware only uses fields supported by its generator.',dialog);
 const key=el('input',undefined,dialog);key.placeholder='module.field';const value=el('textarea',undefined,dialog);value.placeholder='JSON value: 123, true, "text", [], {}';
 const error=el('p','',dialog);button('Cancel',()=>dialog.close(),dialog);button('Apply',()=>{try{const parsed=JSON.parse(value.value);send('addField',{version,path:key.value.split('.'),value:parsed});dialog.close();}catch(e){error.textContent=String(e);}},dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();}
function bindingEditor(){const section=moduleGroup('bindings','Bindings');el('p','Add logical names for IOC resources. CAN buses may be shared; select a different bus when your application needs separation.',section);
 if(state.defaults?.bindings)button('Reset module defaults',()=>send('resetDefaults',{group:'bindings'}),section);
 for(const [kind,resource]of Object.entries(state.bindingKinds)){el('h3',kind,section);if(kind.startsWith('gpio_'))el('p','Select a fixed board GPIO role. Pins and active levels belong to board.json.',section);const create=button('Add '+resource.replace('_role',''),()=>bindingForm(kind),section);create.disabled=!state.fresh||!state.trusted;
 for(const [name,value]of Object.entries(state.data.bindings?.[kind]||{})){const row=el('article',undefined,section);row.dataset.viewKey='binding:'+kind+':'+name;el('strong',name,row);const selected=kind==='adc_channels'?`${value.adc}_ch${value.channel}`:typeof value==='object'?value.bus:value;el('p',String(selected),row);if(!(state.context?.hardware[resource]||[]).includes(selected)&&selected!=='none')el('small','Unavailable on current board',row).className='problem';
 const edit=button('Change resource',()=>bindingForm(kind,name,selected),row);edit.disabled=!state.fresh||!state.trusted;
 const rename=button('Rename',()=>renameBinding(kind,name),row);rename.disabled=!state.trusted;const remove=button('Delete',()=>send('binding',{kind,name,action:'delete'}),row);remove.disabled=!state.trusted;}
 }el('h3','Built-in module bindings',section);return section;}
function renameBinding(kind,old){const version=state.version;const dialog=el('dialog',undefined,document.body);el('h2','Rename '+old,dialog);const input=el('input',undefined,dialog);input.value=old;button('Cancel',()=>dialog.close(),dialog);button('Apply',()=>{send('binding',{version,kind,old,name:input.value,action:'rename'});dialog.close();},dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();}
function bindingForm(kind,name,selected){const version=state.version;const dialog=el('dialog',undefined,document.body);el('h2',kind,dialog);const label=el('label','Logical name',dialog);const key=el('input',undefined,label);key.value=name||'';key.disabled=Boolean(name);
 let chosen=selected;input({type:'string',resource:state.bindingKinds[kind],choices:kind==='uart_ports'?['none']:undefined},selected,dialog,v=>chosen=v);
 const error=el('p','',dialog);button('Cancel',()=>dialog.close(),dialog);button('Apply',()=>{if(!key.value||!chosen){error.textContent='Enter a name and select a resource';return;}send('binding',{version,kind,name:key.value,action:state.data.bindings?.[kind]?.[name]!==undefined?'update':'add',resource:chosen});dialog.close();},dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();}
function renderContent(message){state=message;$('error').textContent=message.error||'';$('actions').replaceChildren();$('content').replaceChildren();
 $('status').textContent=`编辑板型：${state.board} · preset：${state.preset||'未选择（待 Configure 确认）'} · ${state.status}\n最近结果：${state.last}\n${state.reason}${state.fresh?'':'（资源过期）'} · ${state.local||''}`;
 for(const [name,type] of [['刷新硬件','refresh'],['选择 preset','preset'],['Configure','configure'],['板级 JSON 文本','board']])button(name,()=>send(type),$('actions'));
 if(state.type==='hardware'){const context=state.context;el('h2','Hardware（只读）',$('content'));if(context){el('p',context.mcuFamily,$('content'));for(const [k,v] of Object.entries(context.hardware))el('p',`${k.toUpperCase()}: ${v===null?'暂不支持读取':Array.isArray(v)?v.join(', ')||'已解析，未启用':v?'已启用':'未启用'}`,$('content'));for(const [k,v] of Object.entries(context.files))el('p',`${k}: ${v}`,$('content'));}return;}
 if(state.role==='params'||state.role==='robot')button(state.role==='params'?'Robot (robot.json)':'Application (params.json)',()=>send('switchConfig'),$('actions'));
 button('硬件概览',()=>send('hardware'),$('actions'));button('打开文本',()=>send('text'),$('actions'));
 if(state.error||!state.data)return;
 const groups=new Map();
 if(state.role==='params'){button('Add field',()=>addField(),$('actions'));if(state.defaults)button('Reset board params defaults',()=>send('resetDefaults'),$('actions'));groups.set('bindings',bindingEditor());}
 for(const field of state.fields){if(field.path[0]==='bindings'&&state.bindingKinds?.[field.path[1]])continue;const name=field.path.join('.');const group=field.path[0]==='ps2'?'remoter':String(field.path[0]);if(!groups.has(group)){const section=moduleGroup(group,group==='bmi088'?'BMI088 - Do not modify; use board defaults':group);groups.set(group,section);if(state.role==='params'&&state.defaults?.[group])button('Reset module defaults',()=>send('resetDefaults',{group}),section);}
 const row=el('div',undefined,groups.get(group));row.className='field';row.dataset.viewKey='field:'+name;const label=el('label',name,row);const value=valueAt(state.data,field.path);const control=input(field,value,label,v=>send('set',{path:field.path,value:v}));if(group==='bmi088')control.disabled=true;
 if(value===undefined)el('small','未设置；打开页面不会自动补值',row);if(field.default!==undefined&&state.defaults){const b=button('恢复默认',()=>send('set',{path:field.path,default:true}),row);b.disabled=!state.trusted;}if(state.errors[name])el('small',state.errors[name],row).className='problem';
 if(state.errors[name]&&name==='test.gpio_leds')button('Add test_gpio',()=>bindingForm('gpio_outputs','test_gpio'),row);
 if(state.errors[name]&&name==='test.usart')button('Add test_uart',()=>bindingForm('uart_ports','test_uart'),row);if(state.errors[name]&&name==='test.can')button('Add test_can',()=>bindingForm('can_buses','test_can'),row);if(state.errors[name]&&name==='test.usb')button('Enable USBX',()=>send('set',{path:['build','usbx'],value:true}),row);
 }
 if(state.role==='robot'){const section=el('section',undefined,$('content'));el('h2','电机',section);const add=button('新增电机',()=>motorForm(),section);add.disabled=!state.trusted||!state.fresh;
 const list=state.data.devices?.motors?.list||[];if(Array.isArray(list))list.forEach((m,index)=>{const row=el('article',undefined,section);for(const [key,error] of Object.entries(state.errors))if(key.startsWith(`devices.motors.list.${index}.`))el('small',error,row).className='problem';el('strong',`${index+1}. ${m.name??'未命名'}`,row);el('p',`${m.model} · ${m.can_bus} · ${m.can_id} · ${m.control_mode??'relax（默认）'}`,row);const edit=button('修改',()=>motorForm(index),row);edit.disabled=!state.trusted;const del=button('删除此电机',()=>send('deleteMotor',{index}),row);del.disabled=!state.trusted;});}
}
// Capture before replacing the DOM; restore synchronously before the next paint.
function render(message){
 const x=window.scrollX,y=window.scrollY;
 const visible=[...document.querySelectorAll('[data-view-key]')].filter(n=>n.getClientRects().length&&n.getBoundingClientRect().bottom>0);
 const anchor=visible.find(n=>!n.classList.contains('module'))||visible[0];
 const anchorKey=anchor?.dataset.viewKey,top=anchor?.getBoundingClientRect().top;
 const active=document.activeElement,owner=active?.closest('[data-view-key]');
 const controls=n=>[...n.querySelectorAll('input,select,button,summary')];
 const focusKey=owner?.dataset.viewKey,focusIndex=owner?controls(owner).indexOf(active):-1;
 const selection=active?.tagName==='INPUT'&&['text','search'].includes(active.type)?[active.selectionStart,active.selectionEnd]:undefined;
 const searches=[...document.querySelectorAll('[data-view-key] input[type=search]')].map(n=>[n.closest('[data-view-key]').dataset.viewKey,n.value]);
 renderContent(message);
 const nodes=[...document.querySelectorAll('[data-view-key]')];
 const find=key=>nodes.find(n=>n.dataset.viewKey===key);
 for(const [key,value]of searches){const search=find(key)?.querySelector('input[type=search]');if(search){search.value=value;search.oninput();}}
 if(focusKey&&focusIndex>=0){const owner=find(focusKey),control=owner&&controls(owner)[focusIndex];if(control){control.focus({preventScroll:true});if(selection)control.setSelectionRange(...selection);}}
 const next=find(anchorKey);
 window.scrollTo(x,next?window.scrollY+next.getBoundingClientRect().top-top:y);
}
window.addEventListener('message',event=>{if(event.data.type==='error')$('error').textContent=event.data.message;else render(event.data);});send('ready');

