const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.main-nav');
if(menuButton&&nav){menuButton.addEventListener('click',()=>{const open=nav.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open));});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');menuButton.setAttribute('aria-expanded','false');}));}

document.querySelectorAll('[data-tabs]').forEach(tabs=>{const buttons=[...tabs.querySelectorAll('[data-tab]')];const panels=[...tabs.querySelectorAll('[data-panel]')];buttons.forEach(btn=>btn.addEventListener('click',()=>{buttons.forEach(b=>b.setAttribute('aria-selected','false'));panels.forEach(p=>p.classList.remove('active'));btn.setAttribute('aria-selected','true');tabs.querySelector(`[data-panel="${btn.dataset.tab}"]`).classList.add('active');}));});

const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}})},{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));
document.getElementById('year').textContent=new Date().getFullYear();

const leadForm=document.getElementById('lead-form');
const leadTarget=document.getElementById('lead-form-target');
const leadStatus=document.getElementById('lead-form-status');
const leadSuccess=document.getElementById('lead-success');
const leadInterest=document.getElementById('lead-interest');
let leadSubmitting=false;
let leadContext={};

document.querySelectorAll('a[href="#apply"][data-interest]').forEach(link=>{
  link.addEventListener('click',()=>{
    if(leadInterest)leadInterest.value=link.dataset.interest||'';
  });
});

if(leadForm&&leadTarget){
  leadForm.addEventListener('submit',()=>{
    leadSubmitting=true;
    leadContext={
      interest:leadInterest?leadInterest.value:'',
      level:document.getElementById('lead-level')?.value||''
    };
    const submitButton=leadForm.querySelector('button[type="submit"]');
    if(submitButton)submitButton.disabled=true;
    if(leadStatus)leadStatus.textContent='Надсилаємо заявку…';
  });

  leadTarget.addEventListener('load',()=>{
    if(!leadSubmitting)return;
    leadSubmitting=false;
    window.dataLayer=window.dataLayer||[];
    window.dataLayer.push({
      event:'lead_form_submit',
      form_name:'smartgame_consultation',
      lead_interest:leadContext.interest,
      lead_level:leadContext.level
    });
    leadForm.hidden=true;
    if(leadSuccess)leadSuccess.hidden=false;
  });
}
