(function(){
  'use strict';

  const cfg=window.TASKFORCE_SUPABASE||{};
  const configured=Boolean(cfg.url&&cfg.anonKey&&window.supabase?.createClient);
  const client=configured?window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;
  let publicConversation=null;
  let publicMessages=[];
  let publicChannel=null;
  let publicChannelId='';
  let adminChannel=null;
  let adminReconnectTimer=null;
  let publicReconnectTimer=null;
  let chatState=configured?'connecting':'unconfigured';
  let adminRealtimeStatus='connecting';
  let adminLoading=false;
  let adminPolling=false;
  let refreshTimer=null;
  let pollTimer=null;

  window.taskforceRealtime={configured,client};

  function messageShape(row){return {id:row.id,from:row.sender,text:row.body,time:new Date(row.created_at).getTime()}}
  function conversationShape(row,messages=[]){return {id:row.id,name:row.name,contact:row.contact,status:row.status,created:new Date(row.created_at).getTime(),messages}}
  function stateLabel(){if(chatState==='online')return 'En línea';if(chatState==='error')return 'Sin conexión';if(chatState==='unconfigured')return 'Configuración pendiente';return 'Conectando…'}
  function stateClass(){return chatState==='online'?'online':chatState==='error'||chatState==='unconfigured'?'error':''}
  function publicChatId(){return localStorage.getItem('taskforce_public_chat_remote')||''}

  async function assertAdminAuth(){
    if(!client)throw new Error('Supabase no está configurado');
    const {data,error}=await client.auth.getSession();
    if(error)throw error;
    if(data.session?.user?.email?.toLowerCase()!=='admin@taskforce.uy'){
      const authError=new Error('La sesión de administración no está autenticada en Supabase.');
      authError.code='TASKFORCE_ADMIN_AUTH_REQUIRED';
      throw authError;
    }
  }

  function returnAdminToLogin(){
    if(adminChannel){client.removeChannel(adminChannel);adminChannel=null}
    session=null;screen='login';page='home';localDemoMode=false;save();app();
    toast('Iniciá sesión con la cuenta de administración para ver las consultas reales.');
  }

  async function ensureAnonymous(){
    if(!client)return null;
    const {data}=await client.auth.getSession();
    if(data.session&&!data.session.user.email)return data.session.user;
    if(data.session?.user?.email)return data.session.user;
    const {data:signed,error}=await client.auth.signInAnonymously();
    if(error)throw error;
    return signed.user;
  }

  async function loadPublicConversation(){
    if(!client)return;
    try{
      await ensureAnonymous();
      const id=publicChatId();
      if(!id){chatState='online';if(chatOpen)renderChat();return}
      const {data:conversation,error}=await client.from('chat_conversations').select('*').eq('id',id).maybeSingle();
      if(error)throw error;
      if(!conversation){localStorage.removeItem('taskforce_public_chat_remote');publicConversation=null;publicMessages=[];chatState='online';if(chatOpen)renderChat();return}
      const {data:messages,error:messageError}=await client.from('chat_messages').select('*').eq('conversation_id',id).order('created_at');
      if(messageError)throw messageError;
      const nextConversation=conversationShape(conversation),nextMessages=(messages||[]).map(messageShape);
      const changed=!publicConversation||publicConversation.status!==nextConversation.status||JSON.stringify(publicMessages)!==JSON.stringify(nextMessages);
      publicConversation=nextConversation;
      publicMessages=nextMessages;
      subscribePublic(id);
      chatState='online';
      if(chatOpen&&changed)renderPublicChatKeepingDraft();
    }catch(error){console.error('TaskForce chat:',error);chatState='error';if(chatOpen)renderChat()}
  }

  function subscribePublic(id){
    if(publicChannel&&publicChannelId===id)return;
    if(publicChannel)client.removeChannel(publicChannel);
    publicChannelId=id;
    publicChannel=client.channel('public-chat-'+id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'chat_messages',filter:'conversation_id=eq.'+id},payload=>{
        if(!publicMessages.some(m=>String(m.id)===String(payload.new.id)))publicMessages.push(messageShape(payload.new));
        if(chatOpen)renderPublicChatKeepingDraft();
        else document.querySelector('.chat-launch .unread')?.classList.add('live');
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'chat_conversations',filter:'id=eq.'+id},payload=>{if(publicConversation)publicConversation.status=payload.new.status;if(chatOpen)renderChat()})
      .subscribe(status=>{
        if(status==='SUBSCRIBED'){clearTimeout(publicReconnectTimer);chatState='online';if(chatOpen)renderPublicChatKeepingDraft()}
        if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
          chatState='error';if(chatOpen)renderChat();clearTimeout(publicReconnectTimer);
          publicReconnectTimer=setTimeout(()=>{if(id===publicChannelId&&navigator.onLine){if(publicChannel){client.removeChannel(publicChannel);publicChannel=null}subscribePublic(id)}},10000);
        }
      });
  }

  function renderPublicChatKeepingDraft(){
    const draft=document.querySelector('.chat-form input[name="text"]')?.value||'';
    renderChat();
    const field=document.querySelector('.chat-form input[name="text"]');if(field)field.value=draft;
  }

  async function startRealtimeChat(event){
    event.preventDefault();
    if(!client){localDemoMode=true;originalRenderChat();return}
    const form=event.currentTarget,button=form.querySelector('button');
    button.disabled=true;
    try{
      const user=await ensureAnonymous(),data=new FormData(form);
      const {data:conversation,error}=await client.from('chat_conversations').insert({visitor_id:user.id,name:String(data.get('name')).trim(),contact:String(data.get('contact')).trim()}).select().single();
      if(error)throw error;
      localStorage.setItem('taskforce_public_chat_remote',conversation.id);
      publicConversation=conversationShape(conversation);publicMessages=[];chatState='online';
      subscribePublic(conversation.id);
      await loadPublicConversation();
    }catch(error){console.error('No se pudo iniciar el chat remoto:',error);chatState='error';toast('No se pudo conectar con TaskForce. Revisá tu conexión e intentá nuevamente.');renderChat()}
    finally{button.disabled=false}
  }

  function renderRealtimeChat(){
    if(localDemoMode){renderLocalChat();return}
    const root=document.getElementById('chat-root');if(!root)return;
    if(!chatOpen){root.innerHTML='';return}
    document.querySelector('.chat-launch .unread')?.classList.remove('live');
    const head=`<header class="chat-head"><img class="logo" src="assets/taskforce-logo.png" alt=""><div class="grow"><b>TaskForce</b><small class="realtime-state ${stateClass()}">${stateLabel()}</small></div><button class="chat-close" onclick="toggleChat()">×</button></header>`;
    if(!configured){root.innerHTML=`<aside class="chat-panel">${head}<div class="chat-start"><h3>Chat en preparación</h3><p>La conexión segura con atención todavía no está configurada.</p></div></aside>`;return}
    if(!publicConversation){root.innerHTML=`<aside class="chat-panel">${head}${chatState==='error'?'<div class="chat-alert">No pudimos conectar. Revisá tu conexión e intentá nuevamente.</div>':''}<form class="chat-start" onsubmit="startRealtimeChat(event)"><h3>Empezá la conversación</h3><p>Dejanos tus datos para que administración pueda identificar y continuar tu consulta desde cualquier dispositivo.</p><label>Nombre</label><input class="input" name="name" required minlength="2" maxlength="80" autocomplete="name" placeholder="Tu nombre"><label>Teléfono o correo</label><input class="input" name="contact" required minlength="3" maxlength="120" autocomplete="email" placeholder="Cómo podemos contactarte"><button class="btn primary">Iniciar chat</button></form></aside>`;return}
    root.innerHTML=`<aside class="chat-panel">${head}<div class="chat-messages" id="chat-messages">${publicMessages.map(m=>`<div class="bubble ${m.from==='client'?'client':'company'}">${esc(m.text)}<small>${new Date(m.time).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'})}</small></div>`).join('')}</div>${publicConversation.status==='closed'?'<div class="chat-alert">Esta consulta fue marcada como atendida. Podés enviar otro mensaje para continuar.</div>':''}<form class="chat-form" onsubmit="sendPublicMessage(event)"><input class="input" name="text" maxlength="2000" required autocomplete="off" placeholder="Escribí tu consulta…"><button class="btn primary" aria-label="Enviar">➤</button></form></aside>`;
    setTimeout(()=>document.getElementById('chat-messages')?.scrollTo(0,99999),0);
  }

  async function sendRealtimeMessage(event){
    event.preventDefault();
    const form=event.currentTarget,text=String(new FormData(form).get('text')||'').trim(),button=form.querySelector('button');
    if(!text||!publicConversation)return;
    button.disabled=true;
    const {error}=await client.from('chat_messages').insert({conversation_id:publicConversation.id,sender:'client',body:text});
    if(error){console.error(error);toast('El mensaje no pudo enviarse');button.disabled=false;return}
    if(publicConversation.status==='closed')publicConversation.status='open';
    form.reset();button.disabled=false;
  }

  async function loadAdminChats(){
    if(!client||session?.role!=='admin'||adminLoading)return;
    adminLoading=true;
    try{
      await assertAdminAuth();
      const {data:conversations,error}=await client.from('chat_conversations').select('*').order('updated_at',{ascending:false});
      if(error)throw error;
      const ids=(conversations||[]).map(c=>c.id);let messages=[];
      if(ids.length){const result=await client.from('chat_messages').select('*').in('conversation_id',ids).order('created_at');if(result.error)throw result.error;messages=result.data||[]}
      db.chats=(conversations||[]).map(c=>conversationShape(c,messages.filter(m=>m.conversation_id===c.id).map(messageShape)));
      save();chatState='online';subscribeAdmin();app();
    }catch(error){console.error('TaskForce admin chat:',error);if(error.code==='TASKFORCE_ADMIN_AUTH_REQUIRED'){returnAdminToLogin();return}chatState='error';adminRealtimeStatus='error';if(screen==='internal'&&page==='chats')renderAdminChatView();toast('No se pudieron actualizar las consultas. Reintentaremos automáticamente.')}
    finally{adminLoading=false}
  }

  function subscribeAdmin(){
    if(adminChannel){client.removeChannel(adminChannel);adminChannel=null}
    adminChannel=client.channel('taskforce-admin-chat')
      .on('postgres_changes',{event:'*',schema:'public',table:'chat_conversations'},scheduleAdminRefresh)
      .on('postgres_changes',{event:'*',schema:'public',table:'chat_messages'},scheduleAdminRefresh)
      .subscribe(status=>{
        adminRealtimeStatus=status==='SUBSCRIBED'?'online':(['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)?'error':'connecting');
        if(adminRealtimeStatus==='online'){clearTimeout(adminReconnectTimer);scheduleAdminRefresh()}
        else if(adminRealtimeStatus==='error'){
          clearTimeout(adminReconnectTimer);
          adminReconnectTimer=setTimeout(()=>{if(session?.role==='admin'&&navigator.onLine)subscribeAdmin()},10000);
        }
        if(screen==='internal'&&page==='chats')renderAdminChatView();
      });
  }
  function renderAdminChatView(){
    const drafts=new Map([...document.querySelectorAll('[data-chat-id]')].map(card=>[card.dataset.chatId,card.querySelector('input[name="text"]')?.value||'']));
    const scrollY=window.scrollY;
    app();
    for(const card of document.querySelectorAll('[data-chat-id]')){const field=card.querySelector('input[name="text"]');if(field&&drafts.has(card.dataset.chatId))field.value=drafts.get(card.dataset.chatId)}
    window.scrollTo(0,scrollY);
  }

  async function pollAdminChats(){
    if(!client||session?.role!=='admin'||adminLoading||adminPolling||document.visibilityState==='hidden')return;
    adminPolling=true;
    try{
      await assertAdminAuth();
      const {data:conversations,error}=await client.from('chat_conversations').select('*').order('updated_at',{ascending:false});
      if(error)throw error;
      const ids=(conversations||[]).map(c=>c.id);let messages=[];
      if(ids.length){const result=await client.from('chat_messages').select('*').in('conversation_id',ids).order('created_at');if(result.error)throw result.error;messages=result.data||[]}
      const next=(conversations||[]).map(c=>conversationShape(c,messages.filter(m=>m.conversation_id===c.id).map(messageShape)));
      const changed=JSON.stringify(next)!==JSON.stringify(db.chats);
      db.chats=next;save();
      if(changed&&screen==='internal'&&page==='chats')renderAdminChatView();
      if(adminRealtimeStatus==='error')chatState='online';
    }catch(error){if(error.code==='TASKFORCE_ADMIN_AUTH_REQUIRED'){returnAdminToLogin();return}console.warn('Chat: reintento automático pendiente.',error);adminRealtimeStatus='error';chatState='error';if(screen==='internal'&&page==='chats')renderAdminChatView()}
    finally{adminPolling=false}
  }

  function scheduleAdminRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(pollAdminChats,180)}

  async function realtimeAdminReply(event,id){
    event.preventDefault();const form=event.currentTarget,text=String(new FormData(form).get('text')||'').trim(),button=form.querySelector('button');if(!text)return;
    button.disabled=true;const {error}=await client.from('chat_messages').insert({conversation_id:id,sender:'company',body:text});
    if(error){console.error(error);toast('La respuesta no pudo enviarse');button.disabled=false;return}
    await client.from('chat_conversations').update({status:'open'}).eq('id',id);form.reset();button.disabled=false;toast('Respuesta enviada');
  }

  async function realtimeCloseChat(id){const {error}=await client.from('chat_conversations').update({status:'closed'}).eq('id',id);if(error)return toast('No se pudo cerrar la consulta');toast('Consulta marcada como atendida')}

  const originalLogin=window.login;
  const originalRenderChat=window.renderChat;
  const originalToggleChat=window.toggleChat;
  const originalSendPublicMessage=window.sendPublicMessage;
  const originalAdminReply=window.adminReply;
  const originalAdminChats=window.adminChats;
  const originalCloseChatCase=window.closeChatCase;
  let localDemoMode=false;
  function enterLocalDemo(admin,button){
    localDemoMode=true;chatState='error';
    session={role:'admin',id:admin.id};screen='internal';page='home';save();app();
    toast('Panel y chat demostrativo listos en este navegador.');
    if(button){button.disabled=false;button.textContent='Ingresar'}
  }
  async function realtimeLogin(event){
    event.preventDefault();const form=event.currentTarget,data=new FormData(form),email=String(data.get('email')).toLowerCase(),password=String(data.get('password'));
    const admin=db.admins.find(x=>x.email===email&&x.password===password);
    if(!admin)return originalLogin(event);
    if(!client){enterLocalDemo(admin,form.querySelector('button'));return}
    const button=form.querySelector('button');button.disabled=true;button.textContent='Ingresando…';
    try{
      const {error}=await client.auth.signInWithPassword({email,password});
      if(error)throw error;
    }catch(error){
      console.error('Supabase admin sign-in failed:',error);
      button.disabled=false;button.textContent='Ingresar';toast('No se pudo validar el acceso. Revisá el correo y la contraseña.');
      return;
    }
    session={role:'admin',id:admin.id};screen='internal';page='home';save();app();loadAdminChats();
  }

  const originalLogout=window.logout;
  async function realtimeLogout(){if(client&&session?.role==='admin')await client.auth.signOut();if(adminChannel){client.removeChannel(adminChannel);adminChannel=null}originalLogout();loadPublicConversation()}

  function realtimeAdminChats(){
    if(localDemoMode)return `<div class="chat-alert">Modo demostración local. Los mensajes se comparten entre pestañas de este navegador; para sincronizarlos con otros dispositivos hay que reactivar Supabase.</div>`+originalAdminChats();
    const syncLabel=adminRealtimeStatus==='online'?'En vivo · respaldo automático cada 5 segundos':adminRealtimeStatus==='error'?'Reintentando · respaldo automático cada 5 segundos':adminRealtimeStatus==='polling'?'Actualización automática cada 5 segundos':'Conectando con las consultas…';
    const status=`<div class="chat-sync">${syncLabel}</div>`;
    const cards=db.chats.length?db.chats.map(c=>`<article class="card" data-chat-id="${c.id}"><div class="row"><div><h2>${esc(c.name)}</h2><div class="meta">${esc(c.contact||'Sin contacto')}</div></div><span class="badge ${c.status==='open'?'amber':'green'}">${c.status==='open'?'Abierta':'Atendida'}</span></div><div class="chat-card-messages">${c.messages.map(m=>`<div class="bubble ${m.from==='client'?'client':'company'}">${esc(m.text)}<small>${new Date(m.time).toLocaleTimeString('es-UY',{hour:'2-digit',minute:'2-digit'})}</small></div>`).join('')}</div><form onsubmit="adminReply(event,'${c.id}')"><div class="row"><input class="input" name="text" maxlength="2000" required placeholder="Responder como TaskForce"><button class="btn primary">Enviar</button></div></form><div class="actions"><button class="btn small" onclick="createFromChat('${c.id}')">Convertir en trabajo</button><button class="btn small ghost" onclick="closeChatCase('${c.id}')">Marcar atendida</button></div></article>`).join(''):`<div class="card chat-empty">${empty('Todavía no hay consultas reales')}</div>`;
    return head('Atención comercial','Consultas de clientes','Los mensajes se sincronizan entre celulares y computadoras en tiempo real.')+(chatState==='error'?'<div class="chat-alert">No se pudo actualizar en este momento. Reintentando automáticamente; los mensajes guardados no se pierden.</div>':'')+status+`<div class="grid two">${cards}</div>`;
  }

  window.renderChat=renderRealtimeChat;
  window.toggleChat=function(){if(localDemoMode){chatOpen=!chatOpen;renderLocalChat();return}chatOpen=!chatOpen;renderRealtimeChat();if(chatOpen&&!publicConversation)loadPublicConversation()};
  window.startRealtimeChat=startRealtimeChat;
  window.sendPublicMessage=function(event){if(localDemoMode){sendLocalMessage(event);return}sendRealtimeMessage(event)};
  window.login=realtimeLogin;
  window.logout=realtimeLogout;
  window.adminReply=function(event,id){if(localDemoMode){originalAdminReply(event,id);return}realtimeAdminReply(event,id)};
  window.closeChatCase=function(id){if(localDemoMode){originalCloseChatCase(id);return}realtimeCloseChat(id)};
  window.adminChats=realtimeAdminChats;

  function renderLocalChat(){originalRenderChat();const label=document.querySelector('.chat-head small');if(label)label.textContent='Demostración local · mismo navegador'}
  function sendLocalMessage(event){event.preventDefault();const conversation=db.chats.find(c=>c.id===localStorage.getItem('taskforce_public_chat'));if(!conversation)return;const data=new FormData(event.currentTarget),text=String(data.get('text')||'').trim();if(conversation.name==='Visitante'){conversation.name=String(data.get('name')||'').trim();conversation.contact=String(data.get('contact')||'').trim()}if(!text||!conversation.name||!conversation.contact)return;conversation.messages.push({from:'client',text,time:Date.now()});save();renderLocalChat()}
  window.addEventListener('storage',event=>{
    if(event.key!=='taskforce_db'||!event.newValue)return;
    try{const updated=JSON.parse(event.newValue);if(updated?.version!==7)return;db=updated;
      if(localDemoMode&&session?.role==='admin'&&screen==='internal'&&page==='chats')app();
      else if(localDemoMode&&screen==='public'&&chatOpen)renderLocalChat();
    }catch(error){console.warn('No se pudo actualizar el chat local desde otra pestaña.',error)}
  });

  if(configured){
    client.auth.onAuthStateChange((event,current)=>{if(event==='SIGNED_IN'&&current?.user?.email&&session?.role==='admin')setTimeout(loadAdminChats,0)});
    if(session?.role==='admin'){
      screen='login';localDemoMode=false;
      if(!navigator.onLine||!client){chatState='error';adminRealtimeStatus='error';session=null;save()}
      else client.auth.getSession().then(({data,error})=>{
        if(error||data.session?.user?.email?.toLowerCase()!=='admin@taskforce.uy'){
          session=null;screen='login';page='home';save();app();toast('Volvé a ingresar con la cuenta de administración para ver los mensajes reales.');return;
        }
        session={role:'admin',id:db.admins.find(x=>x.email.toLowerCase()==='admin@taskforce.uy')?.id||'admin'};screen='internal';page='home';save();app();loadAdminChats();
      }).catch(error=>{console.warn('No se pudo recuperar la sesión administrativa.',error);session=null;screen='login';page='home';save();app();toast('Iniciá sesión nuevamente para continuar.')});
    }else if(!navigator.onLine){chatState='error'}
    else loadPublicConversation();
  }else{localDemoMode=true;chatState='error'}
  if(configured){
    pollTimer=setInterval(()=>{
      if(session?.role==='admin')pollAdminChats();
      else if(publicConversation&&document.visibilityState!=='hidden')loadPublicConversation();
    },5000);
    window.addEventListener('online',()=>{
      if(session?.role==='admin'){subscribeAdmin();pollAdminChats()}
      else loadPublicConversation();
    });
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState!=='visible')return;
      if(session?.role==='admin')pollAdminChats();
      else if(publicConversation)loadPublicConversation();
    });
  }
  app();
})();
