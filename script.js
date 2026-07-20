const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('.main-nav');
if(menuButton&&nav){menuButton.addEventListener('click',()=>{const open=nav.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open));});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');menuButton.setAttribute('aria-expanded','false');}));}

document.querySelectorAll('[data-tabs]').forEach(tabs=>{const buttons=[...tabs.querySelectorAll('[data-tab]')];const panels=[...tabs.querySelectorAll('[data-panel]')];buttons.forEach(btn=>btn.addEventListener('click',()=>{buttons.forEach(b=>b.setAttribute('aria-selected','false'));panels.forEach(p=>p.classList.remove('active'));btn.setAttribute('aria-selected','true');tabs.querySelector(`[data-panel="${btn.dataset.tab}"]`).classList.add('active');}));});

const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}})},{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));
document.getElementById('year').textContent=new Date().getFullYear();
