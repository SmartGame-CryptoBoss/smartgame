const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.main-nav');
if(menuButton&&nav){menuButton.addEventListener('click',()=>{const open=nav.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open));});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');menuButton.setAttribute('aria-expanded','false');}));}

document.querySelectorAll('[data-tabs]').forEach(tabs=>{const buttons=[...tabs.querySelectorAll('[data-tab]')];const panels=[...tabs.querySelectorAll('[data-panel]')];buttons.forEach(btn=>btn.addEventListener('click',()=>{buttons.forEach(b=>b.setAttribute('aria-selected','false'));panels.forEach(p=>p.classList.remove('active'));btn.setAttribute('aria-selected','true');tabs.querySelector(`[data-panel="${btn.dataset.tab}"]`).classList.add('active');}));});

const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}})},{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));
document.getElementById('year').textContent=new Date().getFullYear();

const leadForm=document.getElementById('lead-form');
const leadStatus=document.getElementById('lead-form-status');
const leadSuccess=document.getElementById('lead-success');
const leadInterest=document.getElementById('lead-interest');
const leadConfig=window.SMARTGAME_CONFIG||{};
let leadSubmitting=false;
let leadChallenge=null;
let leadChallengePromise=null;

const setLeadStatus=(message,type='')=>{
  if(!leadStatus)return;
  leadStatus.textContent=message;
  leadStatus.className=`form-status ${type}`.trim();
};

const wait=(milliseconds)=>new Promise(resolve=>window.setTimeout(resolve,milliseconds));

const fetchWithTimeout=async(url,options={},timeout=10000)=>{
  const controller=new AbortController();
  const timer=window.setTimeout(()=>controller.abort(),timeout);
  try{return await fetch(url,{...options,signal:controller.signal});}
  finally{window.clearTimeout(timer);}
};

const getLeadChallenge=async(force=false)=>{
  const endpoint=String(leadConfig.leadEndpoint||'').trim();
  if(!endpoint)throw new Error('form_config_missing');
  if(!force&&leadChallenge&&Date.now()-leadChallenge.issuedAt<55*60*1000)return leadChallenge;
  if(!force&&leadChallengePromise)return leadChallengePromise;

  leadChallengePromise=(async()=>{
    const challengeUrl=new URL('challenge',endpoint).toString();
    const response=await fetchWithTimeout(challengeUrl,{headers:{Accept:'application/json'},credentials:'omit'});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result?.ok||!result.challenge)throw new Error(result?.code||'challenge_unavailable');
    leadChallenge={
      token:String(result.challenge),
      issuedAt:Number(result.issuedAt)||Date.now(),
      minSubmitAt:Number(result.minSubmitAt)||Date.now()
    };
    return leadChallenge;
  })();

  try{return await leadChallengePromise;}
  finally{leadChallengePromise=null;}
};

const validateLeadForm=()=>{
  if(!leadForm)return false;
  const nameField=leadForm.elements.namedItem('entry.1386002898');
  const contactField=leadForm.elements.namedItem('entry.1792378795');
  const name=String(nameField?.value||'').trim();
  const contact=String(contactField?.value||'').trim();
  const phoneDigits=contact.replace(/\D/g,'');
  const isPhone=/^\+?[\d\s().-]{7,24}$/.test(contact)&&phoneDigits.length>=7&&phoneDigits.length<=15;
  const isTelegram=/^@[a-zA-Z0-9_]{5,32}$/.test(contact)||/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[a-zA-Z0-9_]{5,32}\/?$/i.test(contact);

  nameField?.setCustomValidity(name.length>=2?'':'Вкажіть ім’я (щонайменше 2 символи).');
  contactField?.setCustomValidity(isPhone||isTelegram?'':'Вкажіть коректний телефон або Telegram.');
  const valid=leadForm.reportValidity();
  if(!valid)setLeadStatus('Перевірте, будь ласка, заповнені поля.','error');
  return valid;
};

const buildLeadPayload=(formData,challenge)=>{
  const contact=String(formData.get('entry.1792378795')||'').trim();
  const isTelegram=/^@|^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(contact);
  return {
    name:String(formData.get('entry.1386002898')||'').trim(),
    phone:isTelegram?'':contact,
    telegram:isTelegram?contact:'',
    level:String(formData.get('entry.1255105175')||'').trim(),
    interest:String(formData.get('entry.1774742956')||'').trim(),
    goal:String(formData.get('entry.1993426930')||'').trim(),
    privacyConsent:Boolean(formData.get('entry.671553290')),
    website:String(formData.get('website')||'').trim(),
    challenge:challenge.token
  };
};

const submitLead=async(payload)=>{
  const endpoint=String(leadConfig.leadEndpoint||'').trim();
  const response=await fetchWithTimeout(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json',Accept:'application/json'},
    credentials:'omit',
    body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result?.ok){
    const error=new Error(result?.code||'submit_failed');
    error.status=response.status;
    throw error;
  }
  return result;
};

const showLeadSuccess=(context,result)=>{
  window.dataLayer=window.dataLayer||[];
  window.dataLayer.push({
    event:'lead_form_submit',
    form_name:'smartgame_consultation',
    lead_interest:context.interest,
    lead_level:context.level,
    lead_duplicate:Boolean(result?.duplicate)
  });
  leadForm.hidden=true;
  if(leadSuccess)leadSuccess.hidden=false;
};

document.querySelectorAll('a[href="#apply"][data-interest]').forEach(link=>{
  link.addEventListener('click',()=>{
    if(leadInterest)leadInterest.value=link.dataset.interest||'';
  });
});

if(leadForm){
  getLeadChallenge().catch(()=>{});

  leadForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if(leadSubmitting||!validateLeadForm())return;
    leadSubmitting=true;
    const leadContext={
      interest:leadInterest?leadInterest.value:'',
      level:document.getElementById('lead-level')?.value||''
    };
    const submitButton=leadForm.querySelector('button[type="submit"]');
    if(submitButton)submitButton.disabled=true;
    setLeadStatus('Надсилаємо заявку…');

    try{
      const challenge=await getLeadChallenge();
      const remaining=Math.max(0,challenge.minSubmitAt-Date.now());
      if(remaining)await wait(remaining);
      const result=await submitLead(buildLeadPayload(new FormData(leadForm),challenge));
      showLeadSuccess(leadContext,result);
    }catch(error){
      const code=String(error?.message||'');
      if(code.startsWith('challenge_')||code==='too_fast'){
        leadChallenge=null;
        getLeadChallenge(true).catch(()=>{});
      }
      if(code==='rate_limited'||code==='lead_rate_limited'){
        setLeadStatus('Забагато спроб. Спробуйте ще раз через хвилину.','error');
      }else if(code==='invalid_payload'||code==='invalid_name'||code==='invalid_phone'||code==='invalid_telegram'||code==='contact_required'||code==='invalid_level'||code==='invalid_interest'||code==='consent_required'){
        setLeadStatus('Перевірте, будь ласка, коректність заповнених полів.','error');
      }else{
        setLeadStatus('Не вдалося надіслати заявку. Спробуйте ще раз трохи пізніше.','error');
      }
      if(submitButton)submitButton.disabled=false;
      leadSubmitting=false;
    }
  });
}
